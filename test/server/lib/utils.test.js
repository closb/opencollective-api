import { assert } from 'chai';

import { cleanTags, exportToPDF } from '../../../server/lib/utils';

describe('server/lib/utils', () => {
  it('exports PDF', done => {
    const data = {
      host: {
        name: 'WWCode',
        currency: 'USD',
      },
      expensesPerPage: [
        [
          {
            amount: 1000,
            currency: 'USD',
            description: 'Pizza',
            paymentProcessorFeeInHostCurrency: 5,
            collective: {
              slug: 'testcollective',
            },
            User: {
              name: 'Xavier',
              email: 'xavier@gmail.com',
            },
          },
        ],
      ],
    };
    exportToPDF('expenses', data).then(buffer => {
      try {
        assert.isAtLeast(buffer.length, 9000, 'PDF length should be at least 9000 bytes');
        done();
      } catch (error) {
        done(error);
      }
    });
  });

  it('clean tags', () => {
    const tags = ['OpenCollective', '#OpenCollective', 'o#penCollective', 'OpenCollective#', '##OpenCollective'];
    const cleanedTags = cleanTags(tags);
    assert.deepEqual(cleanedTags, [
      'OpenCollective',
      'OpenCollective',
      'o#penCollective',
      'OpenCollective#',
      'OpenCollective',
    ]);
  });
});
