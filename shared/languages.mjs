// BCP-47 codes offered in the UI. dir:'rtl' mirrors layouts. cjk:true switches reading-time units to characters.
export const LANGUAGES = [
  {code:'ru', name:'Russian'}, {code:'en', name:'English'}, {code:'sr-Latn', name:'Serbian (Latin)'},
  {code:'sr-Cyrl', name:'Serbian (Cyrillic)'}, {code:'uk', name:'Ukrainian'}, {code:'de', name:'German'},
  {code:'fr', name:'French'}, {code:'es', name:'Spanish'}, {code:'it', name:'Italian'}, {code:'pt', name:'Portuguese'},
  {code:'pl', name:'Polish'}, {code:'tr', name:'Turkish'}, {code:'nl', name:'Dutch'}, {code:'kk', name:'Kazakh'},
  {code:'ar', name:'Arabic', dir:'rtl'}, {code:'he', name:'Hebrew', dir:'rtl'},
  {code:'zh', name:'Chinese', cjk:true}, {code:'ja', name:'Japanese', cjk:true}, {code:'ko', name:'Korean', cjk:true},
];
export const language = code => LANGUAGES.find(l => l.code === code) || {code, name:code};
export const isRTL = code => language(code).dir === 'rtl';
