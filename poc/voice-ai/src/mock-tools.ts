export type PaymentState = 'paid' | 'not_paid' | 'partial';

/** Mock of the client's payment-check API. Scenarios choose the state. */
export const checkPaymentStatus = (customerId: string, state: PaymentState) => {
  switch (state) {
    case 'paid':
      return { customerId, status: 'paid', amountPaid: 5500, paidOn: '2026-10-06', outstanding: 0 };
    case 'partial':
      return {
        customerId,
        status: 'partial',
        amountPaid: 2000,
        paidOn: '2026-10-05',
        outstanding: 3500,
      };
    case 'not_paid':
      return {
        customerId,
        status: 'not_paid',
        amountPaid: 0,
        outstanding: 5500,
        lastChecked: '2026-10-08',
      };
  }
};
