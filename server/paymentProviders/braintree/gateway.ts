import braintree from 'braintree';
import { get } from 'lodash';

import { Service } from '../../constants/connected_account';
import INTERVALS from '../../constants/intervals';
import logger from '../../lib/logger';
import models from '../../models';

const MONTHLY_PLAN_ID = 'monthly';
const YEARLY_PLAN_ID = 'yearly';

export const getBraintreeGatewayForCollective = async (
  collective: typeof models.Collective,
): Promise<braintree.BraintreeGateway> => {
  if (!collective?.HostCollectiveId || !collective?.approvedAt) {
    throw new Error('Cannot use Braintree without a fiscal host');
  }

  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { CollectiveId: collective.HostCollectiveId, service: Service.BRAINTREE },
  });

  if (!connectedAccount) {
    throw new Error('This host does not support Braintree payments yet');
  }

  return new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox, // TODO(Braintree): conditional for prod
    merchantId: connectedAccount.username,
    publicKey: connectedAccount.data.publicKey,
    privateKey: connectedAccount.token,
  });
};

const findCustomer = (gateway: braintree.BraintreeGateway, customerId: string): Promise<braintree.Customer> => {
  return gateway.customer.find(customerId);
};

const updateCustomer = async (
  gateway: braintree.BraintreeGateway,
  customerId: string,
  order: typeof models.Order,
): Promise<braintree.Customer> => {
  const response = await gateway.customer.update(customerId, { paymentMethodNonce: order.paymentMethod.token });
  // TODO Handle errors
  return response.customer;
};

export const createCustomerFromOrder = async (
  gateway: braintree.BraintreeGateway,
  order: typeof models.Order,
): Promise<braintree.Customer> => {
  const fromCollective = order.fromCollective || (await order.getFromCollective());
  const user = await fromCollective.getUser();
  const [firstName, ...lastName] = order.fromCollective.name.split(' ');
  const response = await gateway.customer.create({
    firstName: firstName,
    lastName: lastName.join(' '),
    paymentMethodNonce: order.paymentMethod.token,
    website: fromCollective.website,
    email: user?.email,
    customFields: {
      collective: fromCollective.slug,
      collectiveId: fromCollective.id,
    },
  });

  if (!response.success) {
    // TODO Handle errors
    throw new Error(response.message);
  }
  return response.customer;
};

/**
 * TODO(Braintree): Customer ID should be stored somewhere in FromCollective data
 */
const getOrCreateCustomerForOrder = async (
  gateway: braintree.BraintreeGateway,
  order: typeof models.Order,
): Promise<braintree.Customer> => {
  const fromCollective = order.fromCollective || (await order.getFromCollective());
  const customerId = fromCollective && getCustomerIdFromCollective(fromCollective);
  const customer = customerId && (await findCustomer(gateway, customerId));
  if (customer) {
    try {
      return updateCustomer(gateway, customerId, order);
    } catch (e) {
      // Log errors, but don't crash
      logger.error(`Error while updating ${customerId}: ${e.message}`);
    }
  } else {
    return createCustomerFromOrder(gateway, order);
  }
};

const callTransactionSale = async (
  gateway: braintree.BraintreeGateway,
  order,
  customer,
): Promise<braintree.Transaction> => {
  const response = await gateway.transaction.sale({
    amount: (order.totalAmount / 100).toString(),
    customerId: customer.id,
    paymentMethodNonce: order.paymentMethod.token,
    deviceData: order.paymentMethod.data?.deviceData,
    transactionSource: order.interval ? 'recurring_first' : undefined,
    customFields: {
      collective: order.collective.slug,
      collectiveId: order.collective.id,
      order: order.id,
    },
    options: {
      submitForSettlement: true,
    },
  });

  if (!response.success) {
    // TODO Handle errors
    throw new Error(response.message);
  }

  return response.transaction;
};

const callCreateSubscription = async (
  gateway: braintree.BraintreeGateway,
  order,
  customer,
): Promise<braintree.Transaction> => {
  const subscription = await gateway.subscription.create({
    paymentMethodToken: customer['paymentMethods'][0].token, // TODO(Braintree) make sure we're hitting the right PM
    paymentMethodNonce: order.paymentMethod.token,
    planId: order.interval === INTERVALS.MONTH ? MONTHLY_PLAN_ID : YEARLY_PLAN_ID,
    neverExpires: true,
    price: (order.totalAmount / 100).toString(),
    options: {
      startImmediately: true,
      paypal: {
        description: order.description,
      },
    },
  });
  // TODO Handle errors
  return subscription.transaction;
};

export const executePayment = async (order: typeof models.Order): Promise<braintree.Transaction> => {
  const collective = order.collective || (await order.getCollective());
  const fromCollective = order.fromCollective || (await order.getFromCollective());
  const gateway = await getBraintreeGatewayForCollective(collective);
  const customer = await getOrCreateCustomerForOrder(gateway, order);
  let transaction: braintree.Transaction | null = null;
  if (order.interval) {
    transaction = await callCreateSubscription(gateway, order, customer);
  } else {
    transaction = await callTransactionSale(gateway, order, customer);
  }

  if (fromCollective && !getCustomerIdFromCollective(fromCollective)) {
    await storeCustomerIdInCollective(fromCollective, transaction.customer.id).catch(() => {
      // Ignore errors
    });
  }

  return transaction;
};

const getCustomerIdFromCollective = (fromCollective: typeof models.Collective): string | null => {
  return get(fromCollective.data, 'braintree.customerId');
};

const storeCustomerIdInCollective = async (
  fromCollective: typeof models.Collective,
  customerId: string,
): Promise<typeof models.Collective> => {
  return fromCollective.update({ data: { ...fromCollective.data, braintree: { customerId } } });
};

export const generateBraintreeTokenForClient = async (
  gateway: braintree.BraintreeGateway,
  fromCollective: typeof models.Collective | null = null,
): Promise<string> => {
  const customerId = fromCollective && getCustomerIdFromCollective(fromCollective);
  const response = await gateway.clientToken.generate({ customerId });
  return response.clientToken;
};
