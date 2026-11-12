export const title = 'Goal target edits and contributions serialize safely';
export const state = (v) => `${v.status === 'completed' ? 'Completed' : 'Active'}: saved ${v.raised}, target ${v.target}\nContribution ${v.contribution}; edit ${v.editor}`;
export const step = (action) => ({
  CommitContribution: 'the member reads the current goal and saves a contribution under one write lock',
  RejectCompletedContribution: 'the completed goal rejects a contribution',
  CommitEditor: 'the manager reads the current total and saves target and status under one write lock',
  Done: 'both requests finish',
}[action] ?? action);
