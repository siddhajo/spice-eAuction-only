// THARAI LIST — buyer-wise bags and kilos, INTER beside LOCAL.
//
// The fixture is Auction 14 transcribed VERBATIM from the CHECK LIST the
// office supplied: all 285 lots, their buyer codes, bags, kilos and sale
// types. Every figure asserted below is read off the matching THARAI LIST
// sheet, so this test is the reference pair itself, not a restatement of
// what the code happens to do. If the grouping, the sale-type split, the
// ordering or the bag reconciliation ever drifts, the numbers stop
// matching a real trade and this fails.
//
// Asserted through the RENDERED SPREADSHEET rather than by calling
// tharaiListData in-process: db.js opens its own handle off SPICE_DATA_DIR
// and would read an empty database while the server holds the real one.
// Parsing what the route actually served tests the whole pipeline.
const os = require('os'), path = require('path'), fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tharai-out-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tharai-'));
const PORT = 47412;
const B = `http://127.0.0.1:${PORT}`;

let TOKEN = '';
async function api(method, url, body) {
  const r = await fetch(B + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' },
      TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

// Straight from CHECK LIST.pdf: [lot, buyer, bags, qty, sale]
const REF = `001 WD 2 73.400 WD|002 BL 2 71.700 L|003 VT 1 25.100 L|004 ER 4 163.100 L
005 JJ 1 66.600 L|006 WD 5 190.300 WD|007 VGG 1 48.000 L|008 RD 2 96.400 L
009 ST 1 33.400 L|010 ST 1 55.900 L|011 WD 4 177.400 WD|012 JJ 4 173.800 L
013 ST 5 201.900 L|014 SMS 1 55.400 L|015 BM 2 102.100 I|016 RD 2 80.200 L
017 UA 4 192.500 L|018 WD 3 110.200 WD|019 WD 2 112.700 WD|020 WD 3 121.400 WD
021 BM 1 41.600 I|022 AMS 1 46.800 L|023 VGG 2 100.200 L|024 BM 1 48.400 I
025 AMS 3 100.200 L|026 BM 2 91.800 I|027 GT 4 172.600 L|028 BM 5 220.000 I
029 KSP 3 133.200 L|030 KSP 3 137.400 L|031 UA 3 126.600 L|032 PK 3 122.800 L
033 GT 1 51.200 L|034 GV 3 111.400 L|035 ERJ 2 97.100 L|036 UA 3 101.100 L
037 AZ 2 75.100 L|038 PK 2 105.600 L|039 PS 8 353.100 L|040 RD 1 48.600 L
041 JJK 1 52.600 L|042 PK 3 123.000 L|043 VGG 3 123.600 L|044 ST 3 137.000 L
045 KSP 6 249.600 L|046 BM 2 84.000 I|047 AZ 2 81.000 L|048 ST 2 96.800 L
049 PK 7 326.800 L|050 PK 8 370.800 L|051 SK 7 328.900 I|052 VT 5 204.700 L
053 BM 2 61.800 I|054 PK 5 211.800 L|055 UA 6 300.400 L|056 AD 9 348.900 L
057 PK 6 298.000 L|058 VB 6 264.800 I|059 ST 6 258.600 L|060 BMR 2 108.700 I
061 PK 7 328.900 L|062 JFS 3 150.700 I|063 ER 5 192.000 L|064 GT 5 238.800 L
065 SK 6 290.400 I|066 SK 6 287.200 I|067 SK 6 239.000 I|068 UA 5 243.400 L
069 PSJ 5 237.000 L|070 KSP 5 221.600 L|071 AD 4 163.600 L|072 MM 7 314.200 L
073 JFS 4 179.000 I|074 VB 3 118.600 I|075 AMS 5 217.800 L|076 UA 7 356.000 L
077 GT 8 356.200 L|078 SMS 7 331.400 L|079 ER 6 293.200 L|080 ER 7 319.200 L
081 AC 4 165.200 L|082 ERP 8 353.900 L|083 PK 5 235.900 L|084 AC 9 355.600 L
085 ER 5 255.500 L|086 AC 3 144.400 L|087 JFS 5 239.900 I|088 ER 6 248.400 L
089 ST 6 274.400 L|090 ER 5 265.400 L|091 AC 6 296.900 L|092 AD 7 337.200 L
093 JT 7 342.200 L|094 SKM 6 296.300 I|095 BL 8 363.700 L|096 SKM 7 285.500 I
097 NS 11 523.000 L|098 NS 11 521.200 L|099 VT 7 356.000 L|100 SKM 8 371.100 I
101 PK 11 462.100 L|102 KSP 8 349.400 L|103 PK 3 125.400 L|104 PK 5 210.200 L
105 AG 7 370.400 I|106 UA 7 310.700 L|107 PK 7 307.300 L|108 UA 8 319.700 L
109 VT 7 298.400 L|110 WD 9 415.000 WD|111 PK 6 274.300 L|112 AC 4 167.000 L
113 GS 7 359.400 I|114 SN 8 380.100 I|115 VT 7 309.600 L|116 VT 7 312.700 L
117 WD 9 401.600 WD|118 AC 7 333.300 L|119 AC 7 334.600 L|120 AC 7 327.800 L
121 AD 4 201.000 L|122 SK 5 227.800 I|123 SJ 7 277.200 L|124 ERJ 5 211.200 L
125 ERP 6 295.200 L|126 PK 7 362.800 L|127 VT 6 266.800 L|128 AC 8 350.200 L
129 AC 7 338.600 L|130 SKM 6 285.600 I|131 PK 4 185.800 L|132 JJK 9 442.800 L
133 MH 9 331.200 I|134 MM 8 351.400 L|135 AC 7 295.400 L|136 VVG 7 331.400 I
137 PK 3 132.700 L|138 PK 7 320.100 L|139 NS-1 5 251.000 L|140 UA 7 354.000 L
141 ERP 3 168.200 L|142 PK 8 323.400 L|143 PK 10 431.100 L|144 VT 9 360.900 L
145 JT 7 344.500 L|146 GT 8 374.600 L|147 PK 8 378.600 L|148 VT 6 245.000 L
149 AC 9 384.400 L|150 VT 4 206.600 L|151 BL 10 526.800 L|152 AC 7 280.400 L
153 GV 13 525.600 L|154 AC 6 290.000 L|155 ER 7 305.000 L|156 PK 7 369.900 L
157 ERP 8 377.500 L|158 BMR 7 304.300 I|159 BMR 8 348.600 I|160 ISO 7 320.600 I
161 PK 7 262.300 L|162 PK 6 275.200 L|163 ERP 9 399.900 L|164 AC 7 308.200 L
165 UA 7 355.200 L|166 MH 3 154.200 I|167 VGG 8 339.000 L|168 ISO 10 418.800 I
169 SK 6 248.800 I|170 VT 4 188.600 L|171 RE 7 313.900 I|172 MH 4 140.000 I
173 AMS 4 183.600 L|174 VVG 4 162.400 I|175 PK 4 188.600 L|176 PK 7 345.900 L
177 PK 5 195.700 L|178 BMR 5 209.700 I|179 MS 5 205.300 L|180 NS-1 4 195.300 L
181 PK 6 262.600 L|182 GV 4 153.400 L|183 SK 6 269.000 I|184 GV 8 327.000 L
185 PK 6 252.200 L|186 AMS 6 295.000 L|187 ST 6 297.600 L|188 GV 4 200.600 L
189 VT 6 269.800 L|190 MH 6 275.600 I|191 VGG 2 98.000 L|192 MTC 5 253.600 I
193 PK 5 205.800 L|194 KSP 8 347.800 L|195 PKS 4 166.400 L|196 AC 6 249.100 L
197 ISO 6 251.600 I|198 SK 7 299.700 I|199 BMR 8 340.600 I|200 PKS 6 258.600 L
201 VVG 5 211.400 I|202 SK 4 170.200 I|203 ACP 8 341.000 L|204 ACP 1 44.200 L
205 GS 5 235.400 I|206 PKS 5 242.000 L|207 SSG 8 360.000 I|208 KVS 7 281.200 L
209 AC 6 258.000 L|210 VAS 2 96.000 I|211 WD 2 110.500 WD|212 PKS 5 194.900 L
213 NS 8 387.200 L|214 JT 6 290.500 L|215 SK 5 244.000 I|216 PKS 6 250.100 L
217 KVS 10 472.700 L|218 ISO 5 244.600 I|219 ST 5 198.600 L|220 WD 4 171.900 WD
221 MS 6 231.600 L|222 NS-1 5 211.600 L|223 PKS 6 269.400 L|224 ACP 7 280.000 L
225 RD 3 114.600 L|226 KVS 6 283.600 L|227 GV 7 323.200 L|228 SK 10 439.600 I
229 SK 9 415.400 I|230 SSG 6 320.400 I|231 ER 2 63.200 L|232 VB 7 264.600 I
233 VAS 9 443.300 I|234 PKS 3 128.100 L|235 ST 8 346.600 L|236 KVS 10 490.000 L
237 WD 10 473.000 WD|238 WD 10 471.800 WD|239 AC 10 483.400 L|240 KC 10 469.400 I
241 PKS 5 212.900 L|242 GV 9 425.000 L|243 ACP 6 313.800 L|244 PKS 8 406.000 L
245 WD 11 530.300 WD|246 WD 11 535.500 WD|247 SK 5 242.000 I|248 AC 5 246.400 L
249 SK 9 355.600 I|250 KVS 8 283.400 L|251 NS-1 6 298.100 L|252 VT 8 373.900 L
253 WD 4 201.600 WD|254 WD 6 265.400 WD|255 SK 6 260.700 I|256 MH 1 41.200 I
257 WD 10 460.000 WD|258 SSG 10 464.000 I|259 PKS 10 410.200 L|260 PKS 4 198.300 L
261 ASF 7 280.600 L|262 PKS 3 97.800 L|263 AC 4 185.800 L|264 BMR 3 125.600 I
265 ERP 5 228.200 L|266 VT 2 79.700 L|267 MH 2 83.100 I|268 ER 5 219.400 L
269 MH 2 84.200 I|270 BMR 5 203.600 I|271 MH 3 142.000 I|272 NS-1 3 153.800 L
273 RE 3 128.800 I|274 KVS 1 52.800 L|275 MH 5 197.400 I|276 RD 3 112.100 L
277 WD 6 264.300 WD|278 AC 2 91.700 L|279 VSM 5 229.600 I|280 WD 11 532.700 WD
281 AC 6 285.600 L|282 MH 2 92.800 I|283 AC 8 344.200 L|284 WD 11 528.100 WD
285 RN 16 752.400 L`.split(/[\n|]/).map(s => s.trim()).filter(Boolean).map(s => {
  const p = s.split(/\s+/);
  return { lot: p[0], buyer: p[1], bags: Number(p[2]), qty: Number(p[3]), sale: p[4] };
});

const srv = spawn('node', [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: Object.assign({}, process.env,
    { SPICE_DATA_DIR: TMP, PORT: String(PORT), NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', b => srvLog += b); srv.stderr.on('data', b => srvLog += b);
const cleanup = () => {
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
};

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); }
                             else { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + d : '')); } };

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(B + '/api/health'); if (r.status < 500) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const boot = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOKEN = boot.d && boot.d.token;
  if (!TOKEN) { console.error('login failed', srvLog.slice(-1200)); cleanup(); process.exit(1); }

  const a = (await api('POST', '/api/auctions',
    { ano: '14', date: '2026-08-19', state: 'TAMIL NADU' })).d;
  const aid = a.id || (a.auction && a.auction.id);

  // Write the lots, then stamp code/sale/bags/qty straight onto the row —
  // `sale` is normally derived at price entry, and this fixture needs the
  // reference sheet's own values verbatim.
  for (const r of REF) {
    const c = await api('POST', '/api/lots', {
      auction_id: aid, lot_no: r.lot, name: 'SELLER ' + r.lot,
      qty: r.qty, bags: r.bags, grade: '1', crop: 'CARDAMOM',
    });
    const id = c.d && (c.d.id || (c.d.lot && c.d.lot.id));
    await api('PUT', `/api/lots/${id}`, {
      code: r.buyer, sale: r.sale === 'WD' ? 'W' : r.sale,
      qty: r.qty, bags: r.bags, price: 100, amount: r.qty * 100,
    });
  }

  // Assert through the RENDERED SPREADSHEET rather than by calling
  // tharaiListData in-process: db.js opens its own handle off
  // SPICE_DATA_DIR, which is not the one the server is writing to, so a
  // direct call reads an empty database. Parsing the file the route
  // actually served tests the whole pipeline instead of the middle of it.
  const XLSX = require('xlsx');
  const xr = await fetch(`${B}/api/exports/tharai_list/${aid}?format=xlsx`,
    { headers: { Authorization: 'Bearer ' + TOKEN } });
  const xbuf = Buffer.from(await xr.arrayBuffer());
  fs.writeFileSync(path.join(OUT, 'tharai-list.xlsx'), xbuf);
  const wb = XLSX.read(xbuf, { type: 'buffer' });
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const hi = grid.findIndex(r => (r || []).some(c => String(c || '').trim() === 'INTER BUYER'));
  if (hi < 0) { console.error('no header row in sheet', JSON.stringify(grid.slice(0, 8))); cleanup(); process.exit(1); }
  const body = [];
  let totalRow = null;
  for (let i = hi + 1; i < grid.length; i++) {
    const r = grid[i] || [];
    if (String(r[0] || '').trim().toUpperCase() === 'TOTAL') { totalRow = r; break; }
    if (r.length) body.push(r);
  }
  const num = (v) => Number(v) || 0;
  const side = (bi, qi, gi) => body
    .filter(r => String(r[bi] || '').trim() !== '')
    .map(r => ({ code: String(r[bi]).trim(), qty: num(r[qi]), bags: num(r[gi]) }));
  const d = {
    inter: side(0, 1, 2),
    local: side(4, 5, 6),
    tally: {
      I: { bags: num(totalRow && totalRow[2]), qty: num(totalRow && totalRow[1]) },
      L: { bags: num(totalRow && totalRow[6]), qty: num(totalRow && totalRow[5]) },
      // WD and UNCLASSIFIED are stated in the brand band's meta line.
      W: { bags: 0 }, other: { bags: 0 },
    },
  };
  const metaLine = grid.slice(0, hi).flat()
    .map(c => String(c == null ? '' : c)).find(s => /TOTAL \d+ bags/.test(s)) || '';
  d.tally.W.bags     = num((metaLine.match(/WD (\d+)/) || [])[1]);
  d.tally.other.bags = num((metaLine.match(/UNCLASSIFIED (\d+)/) || [])[1]);
  d.totalBags        = num((metaLine.match(/TOTAL (\d+) bags/) || [])[1]);
  d.totalQty         = d.tally.I.qty + d.tally.L.qty
                     + REF.filter(r => r.sale === 'WD').reduce((s, r) => s + r.qty, 0);
  console.log('  meta:', metaLine);

  console.log('\n[A] reconciliation against THARAI LIST.pdf');
  check('INTER bags = 378',  d.tally.I.bags === 378, String(d.tally.I.bags));
  check('LOCAL bags = 1095', d.tally.L.bags === 1095, String(d.tally.L.bags));
  check('WD bags = 133',     d.tally.W.bags === 133, String(d.tally.W.bags));
  check('total bags = 1606', d.totalBags === 1606, String(d.totalBags));
  check('nothing unclassified', d.tally.other.bags === 0, String(d.tally.other.bags));
  check('INTER qty = 16972.000', Math.abs(d.tally.I.qty - 16972) < 0.001, d.tally.I.qty.toFixed(3));
  check('LOCAL qty = 49218.500', Math.abs(d.tally.L.qty - 49218.5) < 0.001, d.tally.L.qty.toFixed(3));
  check('total qty = 72337.600', Math.abs(d.totalQty - 72337.6) < 0.001, d.totalQty.toFixed(3));

  console.log('\n[B] per-buyer rows, top of each side');
  const iTop = d.inter.slice(0, 5).map(r => `${r.code}/${r.bags}/${r.qty.toFixed(3)}`).join(' ');
  const lTop = d.local.slice(0, 5).map(r => `${r.code}/${r.bags}/${r.qty.toFixed(3)}`).join(' ');
  check('INTER leads SK 97 / 4318.300',
        iTop.startsWith('SK/97/4318.300'), iTop);
  check('…then BMR 38, MH 37, ISO 28, SKM 27',
        iTop === 'SK/97/4318.300 BMR/38/1641.100 MH/37/1541.700 ISO/28/1235.600 SKM/27/1238.500', iTop);
  check('LOCAL leads PK 178 / 7995.600',
        lTop.startsWith('PK/178/7995.600'), lTop);
  check('…then AC 145, VT 79, PKS 65, UA 57',
        lTop === 'PK/178/7995.600 AC/145/6516.200 VT/79/3497.800 PKS/65/2834.700 UA/57/2659.600', lTop);
  check('INTER buyer count = 18', d.inter.length === 18, String(d.inter.length));
  check('LOCAL buyer count = 33', d.local.length === 33, String(d.local.length));
  // Ties break alphabetically: VB/VVG at 16, GS/JFS at 12, KC/RE at 10.
  const iCodes = d.inter.map(r => r.code).join(',');
  check('ties break A→Z (VB before VVG, GS before JFS, KC before RE)',
        /VB,VVG/.test(iCodes) && /GS,JFS/.test(iCodes) && /KC,RE/.test(iCodes), iCodes);
  check('NS and NS-1 stay separate buyers',
        d.local.some(r => r.code === 'NS') && d.local.some(r => r.code === 'NS-1'),
        d.local.map(r => r.code).join(','));

  console.log('\n[C] the two files actually render');
  for (const [fmt, ext] of [['pdf', 'pdf'], ['xlsx', 'xlsx']]) {
    const r = await fetch(`${B}/api/exports/tharai_list/${aid}?format=${fmt}`,
      { headers: { Authorization: 'Bearer ' + TOKEN } });
    const buf = Buffer.from(await r.arrayBuffer());
    check(`tharai_list ?format=${fmt} → ${r.status}`, r.status === 200, String(r.status));
    check(`…and is a non-empty ${ext}`, buf.length > 1000, `${buf.length} bytes`);
    fs.writeFileSync(path.join(OUT, `tharai-list.${ext}`), buf);
  }
  const rc = await fetch(`${B}/api/exports/checklist/${aid}?format=pdf`,
    { headers: { Authorization: 'Bearer ' + TOKEN } });
  const cbuf = Buffer.from(await rc.arrayBuffer());
  check('checklist ?format=pdf still renders', rc.status === 200 && cbuf.length > 1000,
        `${rc.status} / ${cbuf.length} bytes`);
  fs.writeFileSync(path.join(OUT, 'checklist.pdf'), cbuf);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-1200)); cleanup(); process.exit(1); });
