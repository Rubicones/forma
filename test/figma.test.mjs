import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFigmaUrl, figmaLinksIn, readFigma, safeSegment} from '../figma.mjs';
import {addFigmaFiles, createBrandFromFiles} from '../brands.mjs';
import {buildBoard} from '../brand-board.mjs';
import {selectStore} from '../store/index.mjs';
import {memoryStore} from '../store/memory.mjs';

test('figma links: file, design, branch and node links; links found in one scope of the answers', () => {
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbC123/Brand-Book?node-id=12-34&t=x'),
    {key: 'AbC123', nodeId: '12:34', url: 'https://www.figma.com/design/AbC123/Brand-Book?node-id=12-34&t=x'});
  assert.equal(parseFigmaUrl('https://figma.com/file/K1/x/branch/B2/y').key, 'B2');
  assert.equal(parseFigmaUrl('https://example.com/design/AbC'), null);
  assert.equal(parseFigmaUrl('not a link'), null);
  const answers = {
    f_links: [{a: 'https://www.figma.com/design/AAA/Kit', b: 'Brand book'}],
    c_site: 'https://grit.example',
    'c1:f_links': [{a: 'see https://www.figma.com/file/BBB/Client-kit) please'}],
  };
  assert.deepEqual(figmaLinksIn(answers, null), ['https://www.figma.com/design/AAA/Kit']);
  assert.deepEqual(figmaLinksIn(answers, 'c1'), ['https://www.figma.com/file/BBB/Client-kit']);
  assert.equal(safeSegment('Logo / white: v2'), 'Logo - white- v2');
});

// A stand-in for api.figma.com and the image CDN.
function fakeFigma({status = 200, headers = {}} = {}) {
  const calls = [];
  const json = (body, s = 200, h = {}) => ({ok: s < 400, status: s, headers: {get: k => h[k.toLowerCase()] ?? null}, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0)});
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.startsWith('https://cdn.example/')) return {ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('png:' + url).buffer};
    if (status !== 200) return json({err: 'nope'}, status, headers);
    assert.equal(init.headers['X-Figma-Token'], 'tok');
    const u = new URL(url);
    if (u.pathname === '/v1/files/KEY') return json({name: 'Grit / Brand book', styles: {'5:1': {name: 'Brand/Orange', styleType: 'FILL'}, '5:2': {name: 'Heading', styleType: 'TEXT'}},
      document: {children: [
        {type: 'CANVAS', name: 'Logo', children: [{id: '1:1', type: 'FRAME', name: 'Logo', absoluteBoundingBox: {width: 1440, height: 900}}, {id: '1:2', type: 'TEXT', name: 'note'}]},
        {type: 'CANVAS', name: 'Colours', children: [{id: '2:1', type: 'FRAME', name: 'Palette', absoluteBoundingBox: {width: 400, height: 300}}, {id: '2:2', type: 'FRAME', name: 'Hidden', visible: false}, {id: '2:3', type: 'FRAME', name: 'Empty', absoluteBoundingBox: {width: 1000, height: 1000}}]},
      ]}});
    if (u.pathname === '/v1/files/KEY/nodes') return json({nodes: {
      '5:1': {document: {fills: [{type: 'SOLID', color: {r: 1, g: 0.31, b: 0.09, a: 1}}]}},
      '5:2': {document: {style: {fontFamily: 'Grit Sans', fontWeight: 700, fontSize: 48, lineHeightPx: 52.8, textCase: 'UPPER'}}},
    }});
    if (u.pathname === '/v1/images/KEY') {
      const ids = u.searchParams.get('ids').split(',');
      return json({images: Object.fromEntries(ids.map(id => [id, id === '2:3' ? null : 'https://cdn.example/' + id + '@' + u.searchParams.get('scale')]))});
    }
    return json({err: 'Not found'}, 404);
  };
  return {fetchImpl, calls};
}

test('read: frames per page as pictures (small ones sharper), styles with values, hidden and empty left out', async () => {
  const {fetchImpl, calls} = fakeFigma();
  const read = await readFigma('https://www.figma.com/design/KEY/Brand', {token: 'tok', fetchImpl});
  assert.equal(read.folder, 'figma/Grit - Brand book');
  assert.deepEqual(read.files.map(f => f.name), ['figma/Grit - Brand book/styles.json', 'figma/Grit - Brand book/Logo/Logo.png', 'figma/Grit - Brand book/Colours/Palette.png']);
  assert.equal(read.files[2].bytes.toString(), 'png:https://cdn.example/2:1@2');
  const styles = JSON.parse(read.files[0].bytes.toString());
  assert.deepEqual(styles.colours, [{name: 'Brand/Orange', fills: [{color: '#ff4f17'}]}]);
  assert.deepEqual(styles.text, [{name: 'Heading', fontFamily: 'Grit Sans', fontWeight: 700, fontSize: 48, lineHeight: 52.8, textCase: 'upper'}]);
  assert.deepEqual(read.skipped.map(s => s.name), ['Colours / Empty']);
  assert.equal(calls.filter(c => c.startsWith('https://api.figma.com')).length, 4, 'file, styles, two image scales');
});

test('read: Figma’s limits and refusals in words the studio can act on', async () => {
  const free = fakeFigma({status: 429, headers: {'retry-after': '172800', 'x-figma-plan-tier': 'starter', 'x-figma-rate-limit-type': 'low'}});
  await assert.rejects(readFigma('https://www.figma.com/design/KEY/x', {token: 'tok', fetchImpl: free.fetchImpl}), /free Figma team.*2 d.*Duplicate/);
  const seat = fakeFigma({status: 429, headers: {'retry-after': '600', 'x-figma-plan-tier': 'pro', 'x-figma-rate-limit-type': 'low'}});
  await assert.rejects(readFigma('https://www.figma.com/design/KEY/x', {token: 'tok', fetchImpl: seat.fetchImpl}), /Viewer or Collab seat/);
  const shut = fakeFigma({status: 404});
  await assert.rejects(readFigma('https://www.figma.com/design/KEY/x', {token: 'tok', fetchImpl: shut.fetchImpl}), /share it with that account/);
  await assert.rejects(readFigma('https://www.figma.com/design/KEY/x', {token: ''}), /FIGMA_TOKEN/);
  await assert.rejects(readFigma('https://example.com', {token: 'tok'}), /not a link to a Figma file/);
});

test('figma files join the brand; reading the same file again replaces them, other files and notes stay', async () => {
  memoryStore.reset();
  selectStore('memory');
  const id = '7a1c2b9a-1111-4222-8333-444455556666';
  await createBrandFromFiles({id, name: 'Grit', files: [{name: 'logo.svg', bytes: Buffer.from('<svg/>')}], decisions: ['No jokes.'],
    origin: {figma: ['https://www.figma.com/design/KEY/Brand', 'https://www.figma.com/design/OTHER/x']}});
  const {fetchImpl} = fakeFigma();
  const read = await readFigma('https://www.figma.com/design/KEY/Brand', {token: 'tok', fetchImpl});
  const v2 = await addFigmaFiles(id, read);
  assert.equal(v2.version, 2);
  assert.equal(v2.files.filter(f => f.name.startsWith('figma/')).length, 3);
  const again = await addFigmaFiles(id, {...read, files: read.files.slice(0, 2), frames: 1});
  assert.deepEqual(again.files.map(f => f.name), ['logo.svg', 'BRAND-NOTES.md', 'figma/Grit - Brand book/styles.json', 'figma/Grit - Brand book/Logo/Logo.png']);
  assert.equal(again.figma.length, 1);
  const board = buildBoard(again, {figmaConfigured: true});
  assert.deepEqual(board.groups.figma.map(f => f.name), ['figma/Grit - Brand book/Logo/Logo.png']);
  assert.deepEqual([board.figma.files.length, board.figma.links], [1, ['https://www.figma.com/design/OTHER/x']]);
});
