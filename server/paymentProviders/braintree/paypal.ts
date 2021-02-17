import { omit } from 'lodash';

import { TransactionTypes } from '../../constants/transactions';
import { floatAmountToCents } from '../../lib/math';
import { getHostFee, getPlatformFee } from '../../lib/payments';
import models from '../../models';
import { PaymentProviderService } from '../PaymentProviderService';

import { executePayment } from './gateway';

const PayPal: PaymentProviderService = {
  features: {
    recurring: true,
  },

  async processOrder(order: typeof models.Order): Promise<typeof models.Order> {
    const braintreeTransaction = await executePayment(order);
    console.log(braintreeTransaction);
    const amountInHostCurrency = floatAmountToCents(parseFloat(braintreeTransaction.amount));
    const paypalFees = floatAmountToCents(parseFloat(braintreeTransaction['paypal'].transactionFeeAmount));

    // TODO Check braintreeTransaction.paypal.transactionFeeCurrencyIsoCode (should always match host currency)
    // TODO Properly support platform tips
    return models.Transaction.createFromPayload({
      CreatedByUserId: order.CreatedByUserId,
      FromCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      PaymentMethodId: order.PaymentMethodId,
      transaction: {
        type: TransactionTypes.CREDIT,
        OrderId: order.id,
        amount: order.totalAmount,
        currency: order.currency,
        hostCurrency: braintreeTransaction.currencyIsoCode,
        amountInHostCurrency: amountInHostCurrency,
        hostCurrencyFxRate: amountInHostCurrency,
        paymentProcessorFeeInHostCurrency: paypalFees,
        taxAmount: order.taxAmount,
        description: order.description,
        hostFeeInHostCurrency: await getHostFee(amountInHostCurrency, order),
        platformFeeInHostCurrency: await getPlatformFee(order.totalAmount, order),
        data: {
          braintreeTransaction: omit(braintreeTransaction, [
            'samsungPayCard',
            'visaCheckoutCard',
            'androidPayCard',
            'applePayCard',
            'localPayment',
            'merchantAddress',
            'disbursementDetails',
            'billing',
          ]),
        },
      },
    });
  },
};

export default PayPal;
