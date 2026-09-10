'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function sourceFingerprint(root) {
  const files = ['CMakeLists.txt', 'src/main.cpp', 'src/byze_rxhash.cpp']
  const out = {}
  for (const rel of files) {
    const file = path.join(root, rel)
    if (!fs.existsSync(file)) throw new Error(`Required upstream source missing: ${rel}`)
    out[rel] = hashFile(file)
  }
  return out
}

function copySourceTree(sourceRoot, destinationRoot) {
  const src = path.resolve(sourceRoot)
  const dst = path.resolve(destinationRoot)
  if (src === dst || dst.startsWith(src + path.sep)) throw new Error('Destination must not be inside the upstream checkout')
  sourceFingerprint(src)
  fs.rmSync(dst, { recursive:true, force:true })
  fs.mkdirSync(path.dirname(dst), { recursive:true })
  fs.cpSync(src, dst, {
    recursive:true,
    dereference:true,
    filter:(source) => {
      const rel = path.relative(src, source)
      if (!rel) return true
      const parts = rel.split(path.sep)
      return !parts.some((p) => p === '.git' || p === 'build' || p === '__pycache__') && !/\.DS_Store$|\.bak$|\.pre-contract-/.test(rel)
    }
  })
  return dst
}

function replaceOne(state, pattern, replacement, label) {
  if (!pattern.test(state.source)) throw new Error(`P2Pool native source patch incompatible: ${label}`)
  state.source = state.source.replace(pattern, replacement)
}

function patchP2PoolMinerSource(root) {
  const file = path.join(root, 'src', 'main.cpp')
  const cmakeFile = path.join(root, 'CMakeLists.txt')
  let source = fs.readFileSync(file, 'utf8')
  const state = { source }

  if (!state.source.includes('contract-direct-coinbase-v1') && !state.source.includes('contract-direct-coinbase-v2')) {
    replaceOne(state, /struct\s+TemplateTx\s*\{/, 'struct CoinbaseOutput { uint64_t value{0}; std::vector<uint8_t> script; };\nstruct TemplateTx {', 'CoinbaseOutput')
    replaceOne(state, /std::string\s+coinbase_script_hex\s*;/, 'std::string coinbase_script_hex;\n    std::vector<CoinbaseOutput> coinbase_outputs;', 'Job.coinbase_outputs')
    const coinbasePattern=/WriteVarInt\(txw,\s*2\);\s*WriteVarInt\(txnw,\s*2\);\s*WriteLE64\(txw,\s*job\.coinbase_value\);\s*WriteLE64\(txnw,\s*job\.coinbase_value\);\s*std::vector<(?:unsigned\s+char|uint8_t)>\s+payout_script\s*=\s*HexToBytes\(job\.coinbase_script_hex\);\s*if\s*\(payout_script\.empty\(\)\)\s*\{?\s*payout_script\.push_back\(0x51\);\s*\}?\s*WriteVarInt\(txw,\s*payout_script\.size\(\)\);\s*WriteVarInt\(txnw,\s*payout_script\.size\(\)\);\s*txw\.insert\(txw\.end\(\),\s*payout_script\.begin\(\),\s*payout_script\.end\(\)\);\s*txnw\.insert\(txnw\.end\(\),\s*payout_script\.begin\(\),\s*payout_script\.end\(\)\);/m
    replaceOne(state, coinbasePattern, `const bool direct_multi = !job.coinbase_outputs.empty();
    WriteVarInt(txw, (direct_multi ? job.coinbase_outputs.size() : 1) + 1);
    WriteVarInt(txnw, (direct_multi ? job.coinbase_outputs.size() : 1) + 1);
    if (direct_multi) {
        uint64_t sum = 0;
        for (const auto& output : job.coinbase_outputs) {
            if (output.script.empty() || output.value == 0 || UINT64_MAX - sum < output.value) throw std::runtime_error("invalid direct coinbase output");
            sum += output.value;
            WriteLE64(txw, output.value); WriteLE64(txnw, output.value);
            WriteVarInt(txw, output.script.size()); WriteVarInt(txnw, output.script.size());
            txw.insert(txw.end(), output.script.begin(), output.script.end());
            txnw.insert(txnw.end(), output.script.begin(), output.script.end());
        }
        if (sum != job.coinbase_value) throw std::runtime_error("direct coinbase outputs do not conserve coinbasevalue");
    } else {
        WriteLE64(txw, job.coinbase_value); WriteLE64(txnw, job.coinbase_value);
        std::vector<uint8_t> payout_script = HexToBytes(job.coinbase_script_hex);
        if (payout_script.empty()) payout_script.push_back(0x51);
        WriteVarInt(txw, payout_script.size()); WriteVarInt(txnw, payout_script.size());
        txw.insert(txw.end(), payout_script.begin(), payout_script.end());
        txnw.insert(txnw.end(), payout_script.begin(), payout_script.end());
    }`, 'BuildCoinbaseTx')
    replaceOne(state, /j\.coinbase_script_hex\s*=\s*obj\.get<std::string>\("template\.coinbasescript",\s*""\)\s*;/, `j.coinbase_script_hex = obj.get<std::string>("template.coinbasescript", "");
                    if (const auto outs = obj.get_child_optional("template.coinbaseoutputs")) {
                        uint64_t sum = 0;
                        for (const auto& ent : *outs) {
                            CoinbaseOutput out;
                            out.value = ent.second.get<uint64_t>("value", 0);
                            out.script = HexToBytes(ent.second.get<std::string>("script", ""));
                            if (!out.value || out.script.empty() || UINT64_MAX - sum < out.value) { j.coinbase_outputs.clear(); break; }
                            sum += out.value;
                            j.coinbase_outputs.push_back(std::move(out));
                        }
                        if (!j.coinbase_outputs.empty() && sum != j.coinbase_value) j.coinbase_outputs.clear();
                    }`, 'notify parser v1')
    replaceOne(state, /int\s+main\s*\(int\s+argc,\s*char\*\*\s*argv\)\s*\{/, `int main(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) if (std::string(argv[i]) == "--features") { std::cout << "contract-direct-coinbase-v1\\n"; return 0; }`, '--features v1')
  }

  if (state.source.includes('contract-direct-coinbase-v1')) {
    state.source = state.source.replace(/contract-direct-coinbase-v1/g, 'contract-direct-coinbase-v2')
    replaceOne(state, /std::vector<CoinbaseOutput>\s+coinbase_outputs\s*;/, 'std::vector<CoinbaseOutput> coinbase_outputs;\n    bool coinbase_outputs_present{false};', 'Job.coinbase_outputs_present')
    replaceOne(state, /const bool direct_multi = !job\.coinbase_outputs\.empty\(\);/, `if (job.coinbase_outputs_present && job.coinbase_outputs.empty()) throw std::runtime_error("direct coinbase outputs required but invalid");
    const bool direct_multi = job.coinbase_outputs_present;`, 'BuildCoinbaseTx fail-closed')
    const parser=/if \(const auto outs = obj\.get_child_optional\("template\.coinbaseoutputs"\)\) \{\s*uint64_t sum = 0;\s*for \(const auto& ent : \*outs\) \{\s*CoinbaseOutput out;\s*out\.value = ent\.second\.get<uint64_t>\("value", 0\);\s*out\.script = HexToBytes\(ent\.second\.get<std::string>\("script", ""\)\);\s*if \(!out\.value \|\| out\.script\.empty\(\) \|\| UINT64_MAX - sum < out\.value\) \{ j\.coinbase_outputs\.clear\(\); break; \}\s*sum \+= out\.value;\s*j\.coinbase_outputs\.push_back\(std::move\(out\)\);\s*\}\s*if \(!j\.coinbase_outputs\.empty\(\) && sum != j\.coinbase_value\) j\.coinbase_outputs\.clear\(\);\s*\}/m
    replaceOne(state, parser, `if (const auto outs = obj.get_child_optional("template.coinbaseoutputs")) {
                        j.coinbase_outputs_present = true;
                        uint64_t sum = 0;
                        bool invalid_direct_outputs = false;
                        for (const auto& ent : *outs) {
                            CoinbaseOutput out;
                            out.value = ent.second.get<uint64_t>("value", 0);
                            out.script = HexToBytes(ent.second.get<std::string>("script", ""));
                            if (!out.value || out.script.empty() || UINT64_MAX - sum < out.value) { invalid_direct_outputs = true; break; }
                            sum += out.value;
                            j.coinbase_outputs.push_back(std::move(out));
                        }
                        if (invalid_direct_outputs || j.coinbase_outputs.empty() || sum != j.coinbase_value) {
                            LogLine("reject mining.notify: invalid direct coinbase outputs");
                            continue;
                        }
                    }`, 'notify parser fail-closed')
    const submitOld = `<< cfg.wallet << "." << cfg.worker << "\\\",\\\"" << block_hex << "\\\",\\\"" << job.id\n                                        << "\\\"]}";`
    if (!state.source.includes(submitOld)) throw new Error('P2Pool native source patch incompatible: mining.submit coinbase proof')
    state.source = state.source.replace(submitOld, `<< cfg.wallet << "." << cfg.worker << "\\\",\\\"" << block_hex << "\\\",\\\"" << job.id\n                                        << "\\\",\\\"" << BytesToHex(coinbase.no_witness) << "\\\"]}";`)
  }

  if (!state.source.includes('contract-direct-coinbase-v2') || !state.source.includes('coinbase_outputs_present') || !state.source.includes('BytesToHex(coinbase.no_witness)')) {
    throw new Error('P2Pool native source patch incomplete')
  }
  fs.writeFileSync(file, state.source)

  let cmake = fs.readFileSync(cmakeFile, 'utf8')
  cmake = cmake.replace(/find_package\(Boost\s+REQUIRED\s+COMPONENTS\s+system\s*\)/, 'find_package(Boost REQUIRED)')
  cmake = cmake.replace(/\bBoost::system\b/g, 'Boost::headers')
  cmake = cmake.replace(/\bbyze-miner\b/g, 'byze-p2pool-miner')
  const boostDefs = 'BOOST_BIND_GLOBAL_PLACEHOLDERS CONTRACT_BOOST_SYSTEM_HEADER_ONLY BOOST_ERROR_CODE_HEADER_ONLY BOOST_SYSTEM_NO_LIB'
  if (/target_compile_definitions\(byze-p2pool-miner\s+PRIVATE\s+BOOST_BIND_GLOBAL_PLACEHOLDERS\s*\)/.test(cmake)) {
    cmake = cmake.replace(/target_compile_definitions\(byze-p2pool-miner\s+PRIVATE\s+BOOST_BIND_GLOBAL_PLACEHOLDERS\s*\)/, `target_compile_definitions(byze-p2pool-miner PRIVATE ${boostDefs})`)
  } else if (!cmake.includes('CONTRACT_BOOST_SYSTEM_HEADER_ONLY')) {
    cmake += `\ntarget_compile_definitions(byze-p2pool-miner PRIVATE ${boostDefs})\n`
  }
  fs.writeFileSync(cmakeFile, cmake)
  return { main:file, cmake:cmakeFile }
}

module.exports = { hashFile, sourceFingerprint, copySourceTree, patchP2PoolMinerSource }
