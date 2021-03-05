import { GraphQLEnumType } from 'graphql';

import { PAYMENT_METHOD_SERVICE } from '../../../constants/paymentMethods';

export const PaymentMethodService = new GraphQLEnumType({
  name: 'PaymentMethodService',
  values: Object.keys(PAYMENT_METHOD_SERVICE).reduce((values, key) => {
    return { ...values, [key]: {} };
  }, {}),
});
