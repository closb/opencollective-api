import { expect } from 'chai';
import config from 'config';

import {
  createCustomerFromOrder,
  generateBraintreeTokenForClient,
  getBraintreeGatewayForCollective,
} from '../../../../server/paymentProviders/braintree/gateway';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
} from '../../../test-helpers/fake-data';

/**
 * Tests plugged directly on Braintree's sandbox.
 * See https://developers.braintreepayments.com/reference/general/testing/node for details
 * about test values.
 */
describe('server/paymentProviders/braintree/gateway', () => {
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

  describe('getBraintreeGatewayForCollective', () => {
    it('throws an error if collective does not have a host', async () => {
      const collective = await fakeCollective({ HostCollectiveId: null });
      await expect(getBraintreeGatewayForCollective(collective)).to.be.rejectedWith(
        'Cannot use Braintree without a fiscal host',
      );
    });

    it('throws an error if collective host has not braintree account connected', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      await expect(getBraintreeGatewayForCollective(collective)).to.be.rejectedWith(
        'This host does not support Braintree payments yet',
      );
    });

    it('returns the properly configured gateway', async () => {
      const gateway = await getBraintreeGatewayForCollective(collectiveWithBraintree);
      expect(gateway.config.merchantId).to.eq(braintreeConnectedAccount.username);
      expect(gateway.config.privateKey).to.eq(braintreeConnectedAccount.token);
      expect(gateway.config.publicKey).to.eq(braintreeConnectedAccount.data.publicKey);
    });
  });

  describe('createCustomerFromOrder', () => {
    it('creates the customer with a valid nonce', async () => {
      const gateway = await getBraintreeGatewayForCollective(collectiveWithBraintree);
      const paymentMethod = await fakePaymentMethod({ token: 'fake-valid-nonce', service: 'braintree' });
      const order = await fakeOrder({ PaymentMethodId: paymentMethod.id });
      const customer = await createCustomerFromOrder(gateway, order);
      expect(customer).to.exist;
      expect(customer.firstName).to.eq(order.fromCollective.name.split(' ')[0]);
      expect(customer.email).to.eq((await order.fromCollective.getUser()).email);
      expect(customer.website).to.eq(order.fromCollective.website);
      expect(customer.customFields.collective).to.eq(order.fromCollective.slug);
      expect(customer.customFields.collectiveId).to.eq(order.fromCollective.id.toString());
    });

    it('rejects if nonce is invalid', async () => {
      const gateway = await getBraintreeGatewayForCollective(collectiveWithBraintree);
      const paymentMethod = await fakePaymentMethod({ token: 'invalid-nonce', service: 'braintree' });
      const order = await fakeOrder({ PaymentMethodId: paymentMethod.id });
      await expect(createCustomerFromOrder(gateway, order)).to.be.rejectedWith(
        'Unknown or expired payment_method_nonce',
      );
    });
  });

  describe('generateBraintreeTokenForClient', () => {
    it('if no fromCollective provided', async () => {
      const gateway = await getBraintreeGatewayForCollective(collectiveWithBraintree);
      const token = await generateBraintreeTokenForClient(gateway);
      expect(token).to.exist;
    });

    it('if fromCollective has no customerId', async () => {
      const fromCollective = await fakeCollective();
      const gateway = await getBraintreeGatewayForCollective(collectiveWithBraintree);
      const token = await generateBraintreeTokenForClient(gateway, fromCollective);
      expect(token).to.exist;
    });

    it('with an invalid customerId', async () => {
      const fromCollective = await fakeCollective({ data: { braintree: { customerId: 'invalid' } } });
      const gateway = await getBraintreeGatewayForCollective(collectiveWithBraintree);
      const token = await generateBraintreeTokenForClient(gateway, fromCollective);
      expect(token).to.not.exist;
    });

    it('with a valid customerId', async () => {
      const fromCollective = await fakeCollective();
      const gateway = await getBraintreeGatewayForCollective(collectiveWithBraintree);
      const paymentMethod = await fakePaymentMethod({
        token: 'fake-valid-nonce',
        service: 'braintree',
        CollectiveId: fromCollective.id,
      });
      const order = await fakeOrder({ FromCollectiveId: fromCollective.id, PaymentMethodId: paymentMethod.id });
      const customer = await createCustomerFromOrder(gateway, order);
      await fromCollective.update({ data: { customerId: customer.id } });
      const token = await generateBraintreeTokenForClient(gateway, fromCollective);
      expect(token).to.exist;
    });
  });
});
