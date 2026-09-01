// Read-only regression for the exact synthetic document created during device acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
async function main() {
  const base = 'http://192.168.5.10:8888';
  const identity = await (await fetch(base + '/api/get_my_id', { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(identity.id, '9fc7ba0a-1531-4cd6-8b33-8e88421c46b4', 'Refuse unexpected application/device');
  const file = 'lanchat-acceptance02-4e67577e-592b-4113-97aa-bbe8a13539e1-1MiB.bin';
  const response = await fetch(base + '/api/download/' + encodeURIComponent(file), { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length, 1048576);
  assert.equal(sha256, 'ee78cd29d3a534713b36e6ff6fa3668c8a8f851a542d5eb2401c25ca4e057d02');
  const report = { time: new Date().toISOString(), device_id: identity.id, file, status: response.status, bytes: bytes.length, sha256, passed: true };
  fs.writeFileSync(path.join(__dirname, '../artifacts/0.2/device/saf-read-build1023.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(report);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
