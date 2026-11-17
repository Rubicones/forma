// The art director's look: a model looks at the rendered preview or final and leaves notes for the designer.
import {apiJson} from './campaign.js';

export const reviewEntry = (campaignId, {requestId, entryId, signal} = {}) =>
  apiJson('/api/campaigns/' + encodeURIComponent(campaignId) + '/review', {
    method: 'POST',
    signal,
    body: JSON.stringify({requestId, entryId}),
  });

export const listReviews = campaignId => apiJson('/api/campaigns/' + encodeURIComponent(campaignId) + '/reviews');

// The message the designer receives. Kept in the user's chat thread like any other revision.
export function reviewRevisionMessage({stage, notes, hasSheets}) {
  const lines = notes.map((n, i) => `${i + 1}. [${n.priority}] ${n.where ? n.where + ': ' : ''}${n.problem}${n.fix ? ' (Hint: ' + n.fix + ')' : ''}`);
  return `Art director's notes on this ${stage === 'preview' ? 'preview' : 'final'}. Solve each one inside the chosen idea. If a note cannot be solved without changing the idea, its subject or its way of making, leave it and say why in your reply.\n${lines.join('\n')}${hasSheets ? '\nThe contact sheets the notes refer to are attached: open them to see each problem.' : ''}`;
}

export const isReviewMessage = text => /^Art director's notes on this /.test(String(text || ''));

export const PRIORITY_LABEL = {P0: 'Must fix', P1: 'Important', P2: 'Polish'};
