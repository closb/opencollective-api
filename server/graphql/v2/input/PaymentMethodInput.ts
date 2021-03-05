import { GraphQLBoolean, GraphQLInputFieldConfigMap, GraphQLInputObjectType, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import { PaymentMethodType } from '../enum';
import { PaymentMethodService } from '../enum/PaymentMethodService';
import { getLegacyServiceTypeFromPaymentMethodType, PaymentMethodTypeEnum } from '../enum/PaymentMethodType';

import { BraintreePaymentInput } from './BraintreePaymentInput';
import { CreditCardCreateInput } from './CreditCardCreateInput';
import { fetchPaymentMethodWithReference } from './PaymentMethodReferenceInput';
import { PaypalPaymentInput } from './PaypalPaymentInput';

export const PaymentMethodInput = new GraphQLInputObjectType({
  name: 'PaymentMethodInput',
  description: 'An input to use for creating or retrieving payment methods',
  fields: (): GraphQLInputFieldConfigMap => ({
    id: {
      type: GraphQLString,
      description: 'The id assigned to the payment method',
    },
    type: {
      type: PaymentMethodType,
      description: 'Type of this payment method',
      deprecationReason: '2021-03-02: Please use service + type',
    },
    legacyType: {
      type: PaymentMethodType,
      description: 'Type of this payment method',
      deprecationReason: '2021-03-02: Please use service + type',
    },
    service: {
      type: PaymentMethodService,
    },
    newType: {
      // TODO: Rename once `type` will be migrated
      type: GraphQLString, // TODO: Use an enum for this one
    },
    name: {
      type: GraphQLString,
      description: 'Name of this payment method',
    },
    isSavedForLater: {
      type: GraphQLBoolean,
      description: 'Wether this payment method should be saved for future payments',
    },
    creditCardInfo: {
      type: CreditCardCreateInput,
      description: 'When creating a credit card, use this field to set its info',
    },
    paypalInfo: {
      type: PaypalPaymentInput,
      description: 'To pass when type is PAYPAL',
    },
    braintreeInfo: {
      type: BraintreePaymentInput,
      description: 'To pass when type is BRAINTREE',
    },
  }),
});

/**
 * Helper that transforms a `PaymentMethodInput` into its GQLV1 sibling, making it safe to
 * pass to `createOrder` (legacy).
 */
export const getLegacyPaymentMethodFromPaymentMethodInput = async (
  pm: Record<string, any>,
): Promise<Record<string, unknown>> => {
  if (!pm) {
    return null;
  } else if (pm.id) {
    return fetchPaymentMethodWithReference(pm);
  }

  let type = pm.type;
  if (pm.service) {
    // Use new way of defining PM
    type = pm.newType || pm.type;
  }

  if (
    pm.type === PaymentMethodTypeEnum.BRAINTREE_PAYPAL ||
    (pm.service === PAYMENT_METHOD_SERVICE.BRAINTREE && type === PAYMENT_METHOD_TYPE.PAYPAL)
  ) {
    return {
      service: PAYMENT_METHOD_SERVICE.BRAINTREE,
      type: PAYMENT_METHOD_TYPE.PAYPAL,
      token: pm.braintreeInfo?.nonce,
      name: pm.braintreeInfo?.description, // TODO Retrieve PayPal account name
      data: {
        accountType: pm.braintreeInfo?.type,
        ...pick(pm.braintreeInfo, ['details', 'binData', 'deviceData']),
      },
    };
  } else if (pm.creditCardInfo) {
    return {
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
      name: pm.name,
      save: pm.isSavedForLater,
      token: pm.creditCardInfo.token,
      data: pick(pm.creditCardInfo, ['brand', 'country', 'expMonth', 'expYear', 'fullName', 'funding', 'zip']),
    };
  } else if (pm.paypalInfo) {
    return {
      service: PAYMENT_METHOD_SERVICE.PAYPAL,
      type: PAYMENT_METHOD_TYPE.PAYMENT,
      ...pick(pm.paypalInfo, ['token', 'data']),
    };
  } else {
    return getLegacyServiceTypeFromPaymentMethodType(pm.type);
  }
};
