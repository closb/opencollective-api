import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import sinon from 'sinon';
import request from 'supertest';
import { v4 as uuid } from 'uuid';

import app from '../../../../server/index';
import models from '../../../../server/models';
import * as paypalPayment from '../../../../server/paymentProviders/paypal/payment';
import * as store from '../../../stores';
import { fakeCollective } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const application = utils.data('application');

describe('server/paymentProviders/paypal/payment', () => {
  let expressApp;

  before(async () => {
    expressApp = await app();
  });

  describe('With PayPal auth', () => {
    /* Another `describe' section is started here to share the stub of
       the PayPal url `/v1/oauth2/token'. Which is pretty much
       everything besides `paypalUrl` and`retrieveOAuthToken`. */

    before(utils.resetTestDB);

    let configStub;
    before(() => {
      /* Stub out the configuration with authentication information
         and environment name. */
      configStub = sinon.stub(config.paypal, 'payment').get(() => ({
        environment: 'sandbox',
      }));
      /* Catch the retrieval of auth tokens */
      nock('https://api.sandbox.paypal.com')
        .persist()
        .post('/v1/oauth2/token')
        .basicAuth({ user: 'my-client-id', pass: 'my-client-secret' })
        .reply(200, { access_token: 'dat-token' }); // eslint-disable-line camelcase
    }); /* End of "before()" */

    const secrets = {
      clientId: 'my-client-id',
      clientSecret: 'my-client-secret',
    };
    let collective, host;
    beforeEach(async () => {
      const paypal = await models.ConnectedAccount.create({
        service: 'paypal',
        clientId: secrets.clientId,
        token: secrets.clientSecret,
      });
      host = await fakeCollective({});
      await host.addConnectedAccount(paypal);
      collective = await fakeCollective({
        HostCollectiveId: host.id,
      });
    });

    after(() => {
      configStub.restore();
      nock.cleanAll();
    }); /* End of "after()" */

    describe('#createPayment', () => {
      before(() => {
        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .post('/v1/payments/payment')
          .reply(200, { id: 'a very legit payment id' });
      }); /* End of "before()" */

      it('should call payments/payment endpoint of the PayPal API', async () => {
        const output = await request(expressApp)
          .post(`/services/paypal/create-payment?api_key=${application.api_key}`)
          .send({ amount: '50', currency: 'USD', hostId: host.id })
          .expect(200);
        expect(output.body.id).to.equal('a very legit payment id');
      }); /* End of "should call payments/payment endpoint of the PayPal API" */
    }); /* End of "#createPayment" */

    describe('#executePayment', () => {
      before(() => {
        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .post('/v1/payments/payment/my-payment-id/execute')
          .reply(200, { success: 'Reply from payment execution' });
      }); /* End of "before()" */

      it('should call payments/payment/<pm-id>/execute endpoint of PayPal API', async () => {
        const order = {
          paymentMethod: {
            data: { paymentID: 'my-payment-id', payerID: 'my-payer-id' },
          },
          collective,
        };
        const output = await paypalPayment.executePayment(order);
        expect(output.success).to.equal('Reply from payment execution');
      }); /* End of "should call payments/payment/<pm-id>/execute endpoint of PayPal API" */
    }); /* End of "#executePayment" */

    describe('#createTransaction', () => {
      beforeEach(utils.resetTestDB);

      it('should create new transactions reflecting the PayPal charges', async () => {
        const { user } = await store.newUser('itsa-mi-mario');

        const { collective } = await store.newCollectiveWithHost('hoodie', 'USD', 'USD', 10);

        const paymentMethod = await models.PaymentMethod.create({
          name: 'test paypal',
          service: 'paypal',
          type: 'payment',
          createdAt: new Date(),
          updatedAt: new Date(),
          CreatedByUserId: user.id,
          uuid: uuid(),
          token: 'EC-88888888888888888',
        });

        const order = await models.Order.create({
          id: 1,
          totalAmount: 5000,
          currency: 'USD',
          description: 'Donation to Hoodie',
          CreatedByUserId: user.id,
          FromCollectiveId: user.collective.id,
          CollectiveId: collective.id,
          PaymentMethodId: paymentMethod.id,
        });
        order.createdByUser = user;
        order.collective = collective;
        order.paymentMethod = paymentMethod;

        /* eslint-disable camelcase */
        const paymentInfo = {
          transactions: [
            {
              amount: { total: '50.00', currency: 'USD' },
              related_resources: [
                {
                  sale: { transaction_fee: { value: '1.75' } },
                },
              ],
            },
          ],
        };
        /* eslint-enable camelcase */

        const tr = await paypalPayment.createTransaction(order, paymentInfo);

        expect(tr.amount).to.equal(5000);
        expect(tr.amountInHostCurrency).to.equal(5000);

        // Currency
        expect(tr.hostCurrencyFxRate).to.equal(1);
        expect(tr.currency).to.equal('USD');
        expect(tr.hostCurrency).to.equal('USD');

        // Fees
        expect(tr.hostFeeInHostCurrency).to.equal(-500); // 10%
        expect(tr.platformFeeInHostCurrency).to.equal(0); // 0%
        expect(tr.paymentProcessorFeeInHostCurrency).to.equal(-175);
      });

      it('works with float amounts', async () => {
        const { user } = await store.newUser('iwantfloaats');
        const { collective } = await store.newCollectiveWithHost('floating', 'USD', 'USD', 10);

        const paymentMethod = await models.PaymentMethod.create({
          name: 'test paypal',
          service: 'paypal',
          type: 'payment',
          createdAt: new Date(),
          updatedAt: new Date(),
          CreatedByUserId: user.id,
          uuid: uuid(),
          token: 'EC-88888888888888888',
        });

        const order = await models.Order.create({
          totalAmount: 5000,
          currency: 'USD',
          description: 'Donation to Hoodie',
          CreatedByUserId: user.id,
          FromCollectiveId: user.collective.id,
          CollectiveId: collective.id,
          PaymentMethodId: paymentMethod.id,
        });
        order.createdByUser = user;
        order.collective = collective;
        order.paymentMethod = paymentMethod;

        /* eslint-disable camelcase */
        const genPaymentInfo = fee => ({
          transactions: [
            {
              amount: { total: '50.00', currency: 'USD' },
              related_resources: [
                {
                  sale: { transaction_fee: { value: fee } },
                },
              ],
            },
          ],
        });
        /* eslint-enable camelcase */

        let tr = await paypalPayment.createTransaction(order, genPaymentInfo('0.28'));
        expect(tr.paymentProcessorFeeInHostCurrency).to.equal(-28);

        tr = await paypalPayment.createTransaction(order, genPaymentInfo('0.29'));
        expect(tr.paymentProcessorFeeInHostCurrency).to.equal(-29);

        tr = await paypalPayment.createTransaction(order, genPaymentInfo('0.56'));
        expect(tr.paymentProcessorFeeInHostCurrency).to.equal(-56);

        tr = await paypalPayment.createTransaction(order, genPaymentInfo('0.532'));
        expect(tr.paymentProcessorFeeInHostCurrency).to.equal(-53);
      });
    }) /** End of #createTransaction */;
  }); /* End of "With PayPal auth" */
});
