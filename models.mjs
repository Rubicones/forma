const standard = ['low','medium','high'];
const extended = [...standard,'xhigh'];
const full = [...extended,'max'];
export const models = {
  claude: {
    'claude-sonnet-5-5':full,
    'claude-opus-5-5':full,
    'claude-sonnet-4-6':standard
  },
  codex: {
    'gpt-5.4':extended,
    'gpt-6.1-sol':full,
    'gpt-6-astra':full
  }
};
export function settings(mode, model, effort) {
  if (mode==='demo') return {};
  if (mode==='claude' && model===undefined && effort===undefined) return {};
  model ??= Object.keys(models[mode])[0];
  effort ??= 'medium';
  if (!Object.hasOwn(models[mode],model) || !models[mode][model].includes(effort)) {
    throw Object.assign(Error('Choose an available model and effort level.'),{status:400});
  }
  return {model,effort};
}
