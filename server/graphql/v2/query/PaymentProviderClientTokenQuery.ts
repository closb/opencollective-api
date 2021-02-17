import { GraphQLNonNull, GraphQLString } from 'graphql';

import {
  generateBraintreeTokenForClient,
  getBraintreeGatewayForCollective,
} from '../../../paymentProviders/braintree/gateway';
import { Forbidden } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';

const PaymentProviderClientTokenQuery = {
  type: new GraphQLNonNull(GraphQLString),
  args: {
    account: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'The account that serves as a payment target',
    },
    fromAccount: {
      type: AccountReferenceInput,
      description: 'The account that is contributing',
    },
    provider: {
      type: new GraphQLNonNull(GraphQLString), // TODO should be an enum
      description: '',
    },
  },
  async resolve(_, args, req): Promise<string> {
    if (args.provider === 'BRAINTREE') {
      const collective = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      const fromCollective = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
      if (fromCollective && !req.remoteUser?.isAdminOfCollective(fromCollective)) {
        throw new Forbidden(`You need to be an admin of ${fromCollective.slug} to use its payment methods`);
      }

      const gateway = await getBraintreeGatewayForCollective(collective);
      return generateBraintreeTokenForClient(gateway, fromCollective);
    } else {
      throw new Error('Provider not supported');
    }
  },
};

export default PaymentProviderClientTokenQuery;
