import { expect } from 'chai';
import sinon from 'sinon';

import { TransactionKind } from '../../../server/constants/transaction-kind';
import models from '../../../server/models';
import { fakeCollective, fakeHost, fakeOrder, fakeUser } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const { Transaction } = models;

const transactionsData = utils.data('transactions1').transactions;

const SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'netAmountInCollectiveCurrency',
  'currency',
  'HostCollectiveId',
  'platformFeeInHostCurrency',
  'paymentProcessorFeeInHostCurrency',
  'taxAmount',
  'amount',
  'description',
];

const SNAPSHOT_COLUMNS_WITH_DEBT = [
  'kind',
  'type',
  'isDebt',
  'FromCollectiveId',
  'CollectiveId',
  'HostCollectiveId',
  'amount',
  'currency',
  'platformFeeInHostCurrency',
  'paymentProcessorFeeInHostCurrency',
  'settlementStatus',
  'description',
];

describe('server/models/Transaction', () => {
  let user, host, inc, collective, defaultTransactionData;

  beforeEach(() => utils.resetTestDB());

  beforeEach(async () => {
    user = await fakeUser({}, { id: 10, name: 'User' });
    inc = await fakeHost({
      id: 8686,
      slug: 'opencollectiveinc',
      name: 'Open Collective',
      CreatedByUserId: user.id,
      HostCollectiveId: 8686,
    });
    host = await fakeHost({
      id: 2,
      name: 'Random Host',
      CreatedByUserId: user.id,
      data: { reimbursePaymentProcessorFeeOnTips: true },
    });
    collective = await fakeCollective({
      id: 3,
      HostCollectiveId: host.id,
      CreatedByUserId: user.id,
      name: 'Collective',
    });
    defaultTransactionData = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
    };
  });

  it('automatically generates uuid', done => {
    Transaction.create({
      amount: -1000,
      ...defaultTransactionData,
    })
      .then(transaction => {
        expect(transaction.info.uuid).to.match(
          /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
        );
        done();
      })
      .catch(done);
  });

  it('get the host', done => {
    Transaction.create({
      ...defaultTransactionData,
      amount: 10000,
    }).then(transaction => {
      expect(transaction.HostCollectiveId).to.equal(host.id);
      done();
    });
  });

  it('createFromPayload creates a double entry transaction for a Stripe payment in EUR with VAT', () => {
    const transaction = {
      description: '€121 for Vegan Burgers including €21 VAT',
      amount: 12100,
      amountInHostCurrency: 12100,
      currency: 'EUR',
      hostCurrency: 'EUR',
      hostCurrencyFxRate: 1,
      platformFeeInHostCurrency: 500,
      hostFeeInHostCurrency: 500,
      paymentProcessorFeeInHostCurrency: 300,
      taxAmount: 2100,
      type: 'CREDIT',
      createdAt: '2015-05-29T07:00:00.000Z',
      PaymentMethodId: 1,
    };

    return Transaction.createFromPayload({
      transaction,
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
    }).then(() => {
      return Transaction.findAll().then(transactions => {
        utils.snapshotTransactions(transactions, { columns: SNAPSHOT_COLUMNS });

        expect(transactions.length).to.equal(2);
        expect(transactions[0].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(transactions[0].type).to.equal('DEBIT');
        expect(transactions[0].netAmountInCollectiveCurrency).to.equal(-12100);
        expect(transactions[0].currency).to.equal('EUR');
        expect(transactions[0].HostCollectiveId).to.be.null;

        expect(transactions[1].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(transactions[1].type).to.equal('CREDIT');
        expect(transactions[1].amount).to.equal(12100);
        expect(transactions[1].platformFeeInHostCurrency).to.equal(-500);
        expect(transactions[1].paymentProcessorFeeInHostCurrency).to.equal(-300);
        expect(transactions[1].taxAmount).to.equal(-2100);
        expect(transactions[1].amount).to.equal(12100);
        expect(transactions[1].netAmountInCollectiveCurrency).to.equal(8700);
        expect(transactions[0] instanceof models.Transaction).to.be.true;
        expect(transactions[0].description).to.equal(transaction.description);
      });
    });
  });

  it('createFromPayload creates a double entry transaction for a Stripe donation in EUR on a USD host', () => {
    const transaction = {
      description: '€100 donation to WWCode Berlin',
      amount: 10000,
      amountInHostCurrency: 11000,
      currency: 'EUR',
      hostCurrency: 'USD',
      hostCurrencyFxRate: 1.1,
      platformFeeInHostCurrency: 550,
      hostFeeInHostCurrency: 550,
      paymentProcessorFeeInHostCurrency: 330,
      type: 'CREDIT',
      createdAt: '2015-05-29T07:00:00.000Z',
      PaymentMethodId: 1,
    };

    return Transaction.createFromPayload({
      transaction,
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
    }).then(() => {
      return Transaction.findAll().then(transactions => {
        expect(transactions.length).to.equal(2);
        expect(transactions[0] instanceof models.Transaction).to.be.true;
        expect(transactions[0].type).to.equal('DEBIT');
        expect(transactions[0].netAmountInCollectiveCurrency).to.equal(-10000);
        expect(transactions[0].currency).to.equal('EUR');
        expect(transactions[0].HostCollectiveId).to.be.null;
        expect(transactions[0].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(transactions[0].description).to.equal(transaction.description);

        expect(transactions[1].type).to.equal('CREDIT');
        expect(transactions[1].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(transactions[1].amount).to.equal(10000);
        expect(transactions[1].platformFeeInHostCurrency).to.equal(-550);
        expect(transactions[1].paymentProcessorFeeInHostCurrency).to.equal(-330);
        expect(transactions[1].taxAmount).to.be.null;
        expect(transactions[1].amount).to.equal(10000);
        expect(transactions[1].netAmountInCollectiveCurrency).to.equal(8700);
      });
    });
  });

  it('createFromPayload() generates a new activity', done => {
    const createActivityStub = sinon.stub(Transaction, 'createActivity').callsFake(t => {
      expect(Math.abs(t.amount)).to.equal(Math.abs(transactionsData[7].netAmountInCollectiveCurrency));
      createActivityStub.restore();
      done();
    });

    Transaction.createFromPayload({
      transaction: transactionsData[7],
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
    })
      .then(transaction => {
        expect(transaction.CollectiveId).to.equal(collective.id);
      })
      .catch(done);
  });

  describe('fees on top', () => {
    it('should deduct the platform fee from the main transactions', async () => {
      const transaction = {
        description: '$100 donation to Merveilles',
        amount: 11000,
        amountInHostCurrency: 11000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 1000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 300,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        data: {
          isFeesOnTop: true,
        },
      };

      const t = await Transaction.createFromPayload({
        transaction,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      expect(t).to.have.property('platformFeeInHostCurrency').equal(0);
      expect(t).to.have.property('kind').equal(TransactionKind.CONTRIBUTION);
      expect(t)
        .to.have.property('netAmountInCollectiveCurrency')
        .equal(
          // The total amount of donation minus the fees on top
          10000 -
            // Minus the host fee
            500 -
            // Minus the partial platform fee: (10000 out of 11000)
            Math.round((300 * 10000) / 11000),
        );
    });

    it('should create an additional pair of transactions between contributor and Open Collective Inc', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });
      const transaction = {
        description: '$100 donation to Merveilles',
        amount: 11000,
        totalAmount: 11000,
        amountInHostCurrency: 11000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 1000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        OrderId: order.id,
        data: {
          isFeesOnTop: true,
        },
      };

      const createdTransaction = await Transaction.createFromPayload({
        transaction,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      // Should have 6 transactions:
      // - 2 for contributions
      // - 2 for platform tip (contributor -> Open Collective)
      // - 2 for platform tip debt (host -> Open Collective)
      const sqlOrder = [['createdAt', 'ASC']];
      const include = [{ association: 'host' }];
      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id }, order: sqlOrder, include });
      await models.TransactionSettlement.attachStatusesToTransactions(allTransactions);
      expect(allTransactions).to.have.length(6);
      await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS_WITH_DEBT);
      utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS_WITH_DEBT });

      // Check base tip transactions
      const tipCredit = allTransactions.find(t => t.CollectiveId === inc.id && !t.isDebt);
      expect(tipCredit).to.have.property('type').equal('CREDIT');
      expect(tipCredit).to.have.property('amount').equal(1000);
      expect(tipCredit).to.have.property('kind').equal(TransactionKind.PLATFORM_TIP);
      expect(tipCredit).to.have.property('TransactionGroup').equal(createdTransaction.TransactionGroup);

      const tipDebit = allTransactions.find(t => t.FromCollectiveId === inc.id && !t.isDebt);
      const partialPaymentProcessorFee = Math.round(200 * (1000 / 11000));
      expect(tipDebit).to.have.property('type').equal('DEBIT');
      expect(tipDebit).to.have.property('kind').equal(TransactionKind.PLATFORM_TIP);
      expect(tipDebit).to.have.property('TransactionGroup').equal(createdTransaction.TransactionGroup);
      expect(tipDebit)
        .to.have.property('amount')
        .equal(-1000 + partialPaymentProcessorFee);

      // Check tip DEBT transactions
      const tipDebtCredit = allTransactions.find(t => t.CollectiveId === inc.id && t.isDebt);
      const tipDebtDebit = allTransactions.find(t => t.CollectiveId === inc.id && t.isDebt);
      expect(tipDebtCredit).to.exist;
      expect(tipDebtDebit).to.exist;

      // Check settlement
      const settlement = await models.TransactionSettlement.getByTransaction(tipCredit);
      expect(settlement).to.exist;
      expect(settlement.status).to.eq('OWED');
    });

    it('should convert the donation transaction to USD and store the FX rate', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        currency: 'EUR',
      });
      const transaction = {
        description: '$100 donation to Merveilles',
        amount: 11000,
        totalAmount: 11000,
        amountInHostCurrency: 11000,
        currency: 'EUR',
        hostCurrency: 'EUR',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 1000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        OrderId: order.id,
        data: {
          isFeesOnTop: true,
        },
      };

      await Transaction.createFromPayload({
        transaction,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id } });
      expect(allTransactions).to.have.length(6);

      const donationCredit = allTransactions.find(t => t.CollectiveId === inc.id);
      expect(donationCredit).to.have.property('type').equal('CREDIT');
      expect(donationCredit).to.have.property('currency').equal('USD');
      expect(donationCredit).to.have.nested.property('data.hostToPlatformFxRate');
      expect(donationCredit)
        .to.have.property('amount')
        .equal(Math.round(1000 * donationCredit.data.hostToPlatformFxRate));

      const donationDebit = allTransactions.find(t => t.FromCollectiveId === inc.id);
      const partialPaymentProcessorFee = Math.round(200 * (1000 / 11000));
      expect(donationDebit).to.have.nested.property('data.hostToPlatformFxRate');
      expect(donationDebit).to.have.property('type').equal('DEBIT');
      expect(donationDebit).to.have.property('currency').equal('USD');
      expect(donationDebit)
        .to.have.property('amount')
        .equal(Math.round((-1000 + partialPaymentProcessorFee) * donationDebit.data.hostToPlatformFxRate));
    });

    it('should not create transactions if platformFee is 0', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        currency: 'EUR',
      });
      const transaction = {
        description: '$100 donation to Merveilles',
        amount: 10000,
        totalAmount: 10000,
        amountInHostCurrency: 10000,
        currency: 'EUR',
        hostCurrency: 'EUR',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        OrderId: order.id,
        data: {
          isFeesOnTop: true,
        },
      };

      await Transaction.createFromPayload({
        transaction,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id } });
      expect(allTransactions).to.have.length(2);
    });
  });

  it('should convert properly when using setCurrency', async () => {
    const order = await fakeOrder({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      currency: 'USD',
    });

    const transaction = {
      description: 'Financial contribution to Booky Foundation',
      amount: 500,
      currency: 'USD',
      amountInHostCurrency: 402,
      hostCurrency: 'EUR',
      hostCurrencyFxRate: 0.804,
      platformFeeInHostCurrency: 0,
      hostFeeInHostCurrency: 0,
      paymentProcessorFeeInHostCurrency: -31,
      type: 'CREDIT',
      PaymentMethodId: 1,
      OrderId: order.id,
      data: {
        charge: { currency: 'usd' },
        balanceTransaction: {
          currency: 'eur',
          exchange_rate: 0.803246, // eslint-disable-line camelcase
        },
      },
    };

    const credit = await Transaction.createFromPayload({
      transaction,
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
    });

    await Transaction.validate(credit);

    await credit.setCurrency('EUR');

    await Transaction.validate(credit);

    expect(credit).to.have.property('currency').equal('EUR');

    expect(credit).to.have.property('amount').equal(402);
  });
});
