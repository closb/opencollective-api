#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import { parse as json2csv } from 'json2csv';
import { entries, groupBy, pick, round, sumBy } from 'lodash';
import moment from 'moment';
import { v4 as uuid } from 'uuid';

import expenseStatus from '../../server/constants/expense_status';
import expenseTypes from '../../server/constants/expense_type';
import { SHARED_REVENUE_PLANS } from '../../server/constants/plans';
import { SETTLEMENT_EXPENSE_PROPERTIES, TransactionTypes } from '../../server/constants/transactions';
import { uploadToS3 } from '../../server/lib/awsS3';
import { generateKey } from '../../server/lib/encryption';
import { parseToBoolean } from '../../server/lib/utils';
import models, { sequelize } from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';

const date = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();
const DRY = process.env.DRY;
const HOST_ID = process.env.HOST_ID;
const isProduction = config.env === 'production';

// Only run on the 1th of the month
if (isProduction && date.date() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the 1st of month, script aborted!');
  process.exit();
} else if (parseToBoolean(process.env.SKIP_HOST_SETTLEMENT)) {
  console.log('Skipping because SKIP_HOST_SETTLEMENT is set.');
  process.exit();
}

if (DRY) {
  console.info('Running dry, changes are not going to be persisted to the DB.');
}

const ATTACHED_CSV_COLUMNS = [
  'createdAt',
  'description',
  'CollectiveSlug',
  'amount',
  'currency',
  'OrderId',
  'TransactionId',
  'PaymentService',
  'source',
];

export async function run() {
  console.info(`Invoicing hosts pending fees and tips for ${moment(date).subtract(1, 'month').format('MMMM')}.`);
  const [pastMonthTransactions] = await sequelize.query(
    `
    WITH "platformTips" AS (
      SELECT
        t."createdAt",
        t."TransactionGroup",
        t."kind",
        t.description,
        t."amountInHostCurrency" as "amount",
        t."hostCurrency" AS "currency",
        ot."CollectiveId",
        c."slug" AS "CollectiveSlug",
        ot."HostCollectiveId",
        h."name" AS "HostName",
        ot."OrderId",
        t.id AS "TransactionId",
        t.data,
        pm."service" AS "PaymentService",
        spm."service" AS "SourcePaymentService",
        'Platform Tips'::TEXT AS "source",
        h.plan,
        CASE
          WHEN h."isActive" THEN h.id
          ELSE (h."settings"->'hostCollective'->>'id')::INT
        END as "chargedHostId"
      FROM
        "Transactions" t
      INNER JOIN "TransactionSettlements" s ON
        t."TransactionGroup" = s."TransactionGroup"
        AND t.kind = s.kind
        AND s.status = 'OWED'
      LEFT JOIN "Transactions" ot ON
        t."TransactionGroup" = ot."TransactionGroup"
        AND ot.type = 'CREDIT'
        AND ot.kind IN ('CONTRIBUTION', 'ADDED_FUNDS') -- we only support adding tips on contributions and addedd funds for now
      LEFT JOIN "Collectives" h ON
        ot."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        ot."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        ot."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month', date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month', date :date)
        AND t."deletedAt" IS NULL
        AND t."kind" = 'PLATFORM_TIP'
        AND t."type" = 'CREDIT'
        AND t."isDebt" IS TRUE
        AND (
          h."type" = 'ORGANIZATION'
          AND h."isHostAccount" = TRUE
        )
      ORDER BY
        t."createdAt"
    ),
    "platformFees" AS (
      SELECT
        t."createdAt",
        t."TransactionGroup",
        t."kind",
        t.description,
        -t."platformFeeInHostCurrency" AS "amount",
        t."hostCurrency" AS "currency",
        t."CollectiveId",
        c."slug" AS "CollectiveSlug",
        t."HostCollectiveId",
        h."name" AS "HostName",
        t."OrderId",
        t.id AS "TransactionId",
        t.data,
        pm."service" AS "PaymentService",
        spm."service" AS "SourcePaymentService",
        'Platform Fees'::TEXT AS "source",
        h.plan,
        CASE
          WHEN h."isActive" THEN h.id
          ELSE (h."settings"->'hostCollective'->>'id')::INT
        END as "chargedHostId"
      FROM
        "Transactions" t
      LEFT JOIN "Collectives" h ON
        t."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        t."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        t."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month', date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month', date :date)
        AND t."deletedAt" IS NULL
        AND t."type" = 'CREDIT'
        AND t."platformFeeInHostCurrency" != 0
        AND t."HostCollectiveId" NOT IN (8686)
        AND (
          pm."service" != 'stripe'
          OR pm.service IS NULL
        )
        AND (
          spm.service IS NULL
          OR spm.service != 'stripe'
        )
        AND (
          h."type" = 'ORGANIZATION'
          AND h."isHostAccount" = TRUE
        )
      ORDER BY
        t."createdAt"
    ),
    "sharedRevenue" as (
      SELECT
        t."createdAt",
        t."TransactionGroup",
        t."kind",
        t.description,
        -t."hostFeeInHostCurrency" AS "amount",
        t."hostCurrency" AS "currency",
        t."CollectiveId",
        c."slug" AS "CollectiveSlug",
        t."HostCollectiveId",
        h."name" AS "HostName",
        t."OrderId",
        t.id AS "TransactionId",
        t.data,
        pm."service" AS "PaymentService",
        spm."service" AS "SourcePaymentService",
        'Shared Revenue'::TEXT AS "source",
        h.plan,
        CASE
          WHEN h."isActive" THEN h.id
          ELSE (h."settings"->'hostCollective'->>'id')::INT
        END as "chargedHostId"
      FROM
        "Transactions" t
      LEFT JOIN "Collectives" h ON
        t."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        t."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        t."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month', date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month', date :date)
        AND t."deletedAt" IS NULL
        AND t."type" = 'CREDIT'
        AND t."hostFeeInHostCurrency" != 0
        -- Ignore transactions that incurred in platformFee
        AND t."platformFeeInHostCurrency" = 0
        AND t."data"->>'settled' IS NULL
        -- Ignore Open Collective:
        AND t."HostCollectiveId" != 8686
      AND (
        h."type" = 'ORGANIZATION'
        AND h."isHostAccount" = TRUE
        AND (h."plan" in ('${SHARED_REVENUE_PLANS.join(
          "', '",
        )}') OR h."data"#>>'{plan, hostFeeSharePercent}' IS NOT NULL)
      )
    ORDER BY
      t."createdAt"
    ),
    "tipPaymentProcessorFee" AS (
      SELECT
        t."createdAt",
        t."TransactionGroup",
        t."kind",
        t.description,
        round(t."paymentProcessorFeeInHostCurrency"::float / COALESCE((t."data"->>'hostToPlatformFxRate')::float, 1)) AS "amount",
        ot."hostCurrency" AS "currency",
        ot."CollectiveId",
        c."slug" AS "CollectiveSlug",
        ot."HostCollectiveId",
        h."name" AS "HostName",
        ot."OrderId",
        t.id AS "TransactionId",
        t.data,
        pm."service" AS "PaymentService",
        spm."service" AS "SourcePaymentService",
        'Reimburse: Payment Processor Fee for collected Platform Tips'::TEXT AS "source",
        h.plan,
        CASE
          WHEN h."isActive" THEN h.id
          ELSE (
            h."settings"->'hostCollective'->>'id'
          )::INT
        END AS "chargedHostId"
      FROM
        "Transactions" t
      LEFT JOIN "Transactions" ot ON
        t."TransactionGroup" = ot."TransactionGroup"
        AND ot.type = 'CREDIT'
        AND ot.kind IN ('CONTRIBUTION', 'ADDED_FUNDS') -- we only support adding tips on contributions and addedd funds for now
      LEFT JOIN "Collectives" h ON
        ot."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        ot."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        t."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month',  date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month',  date :date)
        AND t."deletedAt" IS NULL
        AND t."CollectiveId" = 8686
        AND t."kind" = 'PLATFORM_TIP'
        AND t."type" = 'CREDIT'
        AND t."paymentProcessorFeeInHostCurrency" != 0
        AND ot."HostCollectiveId" NOT IN (8686)
        AND (
          pm."service" = 'stripe'
          OR spm.service = 'stripe'
        )
        AND (
          h."type" = 'ORGANIZATION'
          AND h."isHostAccount" = TRUE
        )
      ORDER BY
        t."createdAt"
    )

    SELECT
      *
    FROM
      "platformFees"
    UNION
    SELECT
      *
    FROM
      "platformTips"
    UNION
    SELECT
      *
    FROM
      "sharedRevenue"
    UNION
    SELECT
      *
    FROM
      "tipPaymentProcessorFee";
  `,
    { replacements: { date: date.format('L') } },
  );
  const byHost = groupBy(pastMonthTransactions, 'HostCollectiveId');
  const today = moment.utc();
  const payoutMethods = groupBy(
    await models.PayoutMethod.findAll({
      where: { CollectiveId: SETTLEMENT_EXPENSE_PROPERTIES.FromCollectiveId },
    }),
    'type',
  );

  for (const [hostId, hostTransactions] of entries(byHost)) {
    if (HOST_ID && hostId != HOST_ID) {
      continue;
    }

    const host = await models.Collective.findByPk(hostId);
    const plan = await host.getPlan();

    const { HostName, currency, chargedHostId } = hostTransactions[0];

    const hostFeeSharePercent = plan?.hostFeeSharePercent;
    const transactions = hostTransactions.map(t => {
      if (t.source === 'Shared Revenue') {
        // In this context, the original t.amount is actually -t.hostFeeInHostCurrency
        t.amount = round(t.amount * ((t.data?.hostFeeSharePercent || hostFeeSharePercent) / 100));
      }
      return t;
    });

    let items = entries(groupBy(transactions, 'source')).map(([source, ts]) => {
      const incurredAt = date;
      const description = source;
      const amount = round(sumBy(ts, 'amount'));
      return { incurredAt, amount, description };
    });

    if (plan.pricePerCollective) {
      const activeHostedCollectives = await host.getHostedCollectivesCount();
      const amount = (activeHostedCollectives || 0) * plan.pricePerCollective;
      if (amount) {
        items.push({
          incurredAt: new Date(),
          amount,
          description: 'Fixed Fee per Hosted Collective',
        });
      }
    }

    const transactionIds = transactions.map(t => t.TransactionId);
    const itemsWithoutDebt = items.filter(i => i.description === 'Platform Fees');
    const totalAmountCredited = sumBy(itemsWithoutDebt, 'amount');
    const totalAmountCharged = sumBy(items, 'amount');
    if (totalAmountCharged < 1000) {
      console.warn(
        `${HostName} (#${hostId}) skipped, total amound pending ${totalAmountCharged / 100} < 10.00 ${currency}.\n`,
      );
      continue;
    }
    console.info(
      `${HostName} (#${hostId}) has ${transactions.length} pending transactions and owes ${
        totalAmountCharged / 100
      } (${currency})`,
    );
    const csv = json2csv(transactions.map(t => pick(t, ATTACHED_CSV_COLUMNS)));

    if (DRY) {
      console.debug(`Items:\n${json2csv(items)}\n`);
      console.debug(csv);
    } else {
      if (!chargedHostId) {
        console.error(`Warning: We don't have a way to submit the expense to ${HostName}, ignoring.\n`);
        continue;
      }
      if (totalAmountCredited > 0) {
        // Credit the Host with platform tips collected during the month
        await models.Transaction.create({
          amount: totalAmountCredited,
          amountInHostCurrency: totalAmountCredited,
          hostFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: 0,
          CollectiveId: chargedHostId,
          CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
          currency: currency,
          description: `Platform Fees collected in ${moment.utc().subtract(1, 'month').format('MMMM')}`,
          FromCollectiveId: chargedHostId,
          HostCollectiveId: hostId,
          hostCurrency: currency,
          hostCurrencyFxRate: 1,
          netAmountInCollectiveCurrency: totalAmountCredited,
          type: TransactionTypes.CREDIT,
          TransactionGroup: uuid(),
          kind: null, // Keeping this one null on purpose, see https://github.com/opencollective/opencollective-api/pull/5884#discussion_r616440055
        });
      }

      const connectedAccounts = await host.getConnectedAccounts({
        where: { deletedAt: null },
      });

      let PayoutMethod =
        payoutMethods[PayoutMethodTypes.OTHER]?.[0] || payoutMethods[PayoutMethodTypes.BANK_ACCOUNT]?.[0];
      if (
        connectedAccounts?.find(c => c.service === 'transferwise') &&
        payoutMethods[PayoutMethodTypes.BANK_ACCOUNT]?.[0]
      ) {
        const currencyCompatibleAccount = payoutMethods[PayoutMethodTypes.BANK_ACCOUNT].find(
          pm => pm.data?.currency === currency,
        );
        PayoutMethod = currencyCompatibleAccount || payoutMethods[PayoutMethodTypes.BANK_ACCOUNT]?.[0];
      } else if (
        connectedAccounts?.find(c => c.service === 'paypal') &&
        !host.settings?.disablePaypalPayouts &&
        payoutMethods[PayoutMethodTypes.PAYPAL]?.[0]
      ) {
        PayoutMethod = payoutMethods[PayoutMethodTypes.PAYPAL]?.[0];
      }

      // Create the Expense
      const expense = await models.Expense.create({
        ...SETTLEMENT_EXPENSE_PROPERTIES,
        PayoutMethodId: PayoutMethod.id,
        amount: totalAmountCharged,
        CollectiveId: chargedHostId,
        currency: currency,
        description: `Platform settlement for ${moment.utc().subtract(1, 'month').format('MMMM')}`,
        incurredAt: today,
        data: { isPlatformTipSettlement: true, transactionIds },
        type: expenseTypes.INVOICE,
        status: expenseStatus.PENDING,
      });

      // Create Expense Items
      items = items.map(i => ({
        ...i,
        ExpenseId: expense.id,
        CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
      }));

      await models.ExpenseItem.bulkCreate(items);

      // Attach CSV
      const Body = csv;
      const filenameBase = `${HostName}-${moment(date).subtract(1, 'month').format('MMMM-YYYY')}`;
      const Key = `${filenameBase}.${generateKey().slice(0, 6)}.csv`;
      const { Location: url } = await uploadToS3({
        Bucket: config.aws.s3.bucket,
        Key,
        Body,
        ACL: 'public-read',
        ContentType: 'text/csv',
      });
      await models.ExpenseAttachedFile.create({
        url,
        ExpenseId: expense.id,
        CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
      });

      // Mark transactions as invoiced
      await models.TransactionSettlement.markTransactionsAsInvoiced(transactions, expense.id);
    }
  }
}

if (require.main === module) {
  run()
    .catch(e => {
      console.error(e);
      process.exit(1);
    })
    .then(() => {
      process.exit();
    });
}
