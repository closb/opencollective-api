/* eslint-disable camelcase */
import { expect } from 'chai';

import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import privacy from '../../../../server/paymentProviders/privacy';
import { fakeCollective, fakePayoutMethod } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const MOCK_TRANSACTION = {
  amount: 243,
  card: {
    created: '2020-07-13T10:22:20Z',
    funding: {
      account_name: 'Silicon Valley Bank',
      created: '2016-05-08 21:25:38',
      last_four: '2598',
      nickname: '',
      state: 'ENABLED',
      token: 'dd2c0187-56cf-44ce-b7d9-ee1c07179e10',
      type: 'DEPOSITORY_CHECKING',
    },
    hostname: '',
    last_four: '0093',
    memo: 'Digital Ocean',
    spend_limit: 5000,
    spend_limit_duration: 'MONTHLY',
    state: 'OPEN',
    token: '2904adfe-abce-427a-b731-f6b2c5380fb6',
    type: 'MERCHANT_LOCKED',
  },
  created: '2021-02-01T15:28:11Z',
  events: [],
  funding: [
    {
      amount: 243,
      token: 'dd2c0187-56cf-44ce-b7d9-ee1c07179e10',
      type: 'DEPOSITORY_CHECKING',
    },
  ],
  merchant: {
    acceptor_id: '445283188990',
    city: 'DIGITALOCEAN.',
    country: 'USA',
    descriptor: 'DIGITALOCEAN.COM',
    mcc: '5734',
    state: 'NY',
  },
  result: 'APPROVED',
  settled_amount: 243,
  status: 'SETTLED',
  token: '9c63b54a-897c-49b7-9210-fc4dfa15b8d0',
};

describe('server/paymentProviders/privacy/index', () => {
  describe('createExpense()', () => {
    let expense, collective;

    before(utils.resetTestDB);
    before(async () => {
      const host = await fakeCollective({ isHostAccount: true });
      collective = await fakeCollective({ isHostAccount: false, HostCollectiveId: host.id });
      await fakePayoutMethod({
        CollectiveId: collective.id,
        type: PayoutMethodTypes.CREDIT_CARD,
        name: '0093',
        data: {
          token: '2904adfe-abce-427a-b731-f6b2c5380fb6',
        },
      });

      expense = await privacy.createExpense(MOCK_TRANSACTION);
    });

    it('should create vendor collective if non-existent', () => {
      expect(expense.collective).to.have.property('name', 'DIGITALOCEAN.COM');
      expect(expense.collective).to.have.property('slug', '445283188990');
    });

    it('should create expense and transactions', async () => {
      const transactions = await expense.getTransactions();

      const debit = transactions.find(t => t.type === 'DEBIT');
      expect(debit).to.have.property('CollectiveId', collective.id);
      expect(debit).to.have.property('amount', -1 * MOCK_TRANSACTION.settled_amount);
    });
  });
});