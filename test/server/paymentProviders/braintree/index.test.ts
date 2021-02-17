import { expect } from 'chai';
import config from 'config';

import { PAYMENT_METHOD_TYPES } from '../../../../server/constants/paymentMethods';
import BrainTree from '../../../../server/paymentProviders/braintree';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
} from '../../../test-helpers/fake-data';

describe('server/paymentProviders/braintree/index', () => {
  let hostWithBraintree, collectiveWithBraintree, braintreeConnectedAccount;

  before(async () => {
    hostWithBraintree = await fakeHost();
    collectiveWithBraintree = await fakeCollective({ HostCollectiveId: hostWithBraintree.id });
    braintreeConnectedAccount = await fakeConnectedAccount({
      CollectiveId: hostWithBraintree.id,
      service: 'braintree',
      username: config.braintree.testGateway.merchantId,
      token: config.braintree.testGateway.privateKey,
      data: { publicKey: config.braintree.testGateway.publicKey },
    });
  });

  describe('processOrder', () => {
    it('should reject non-supported types', async () => {
      const supportedTypes = ['paypal'];
      const unsupportedTypes = PAYMENT_METHOD_TYPES.filter(t => !supportedTypes.includes(t));
      for (const type of unsupportedTypes) {
        const paymentMethod = await fakePaymentMethod({ service: 'braintree', type, token: 'xxxxxx' });
        const order = await fakeOrder({ PaymentMethodId: paymentMethod.id });
        await expect(BrainTree.processOrder(order)).to.be.rejectedWith('not supported yet');
      }
    });

    describe('process paypal order', () => {
      it('works with a one-time contribution', async () => {
        const paymentMethod = await fakePaymentMethod({
          service: 'braintree',
          type: 'paypal',
          token: 'fake-paypal-billing-agreement-nonce',
        });
        const order = await fakeOrder({ PaymentMethodId: paymentMethod.id, CollectiveId: collectiveWithBraintree.id });
        const result = await BrainTree.processOrder(order);
        console.log(result);
      });
    });
  });
});
