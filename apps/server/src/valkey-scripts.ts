const LUA_AUTH_HELPERS = String.raw`
local function has_complete_bundle(expires_at_ms)
  if not (
    redis.call('TYPE', KEYS[1]).ok == 'hash' and
    redis.call('TYPE', KEYS[2]).ok == 'hash' and
    redis.call('TYPE', KEYS[3]).ok == 'stream' and
    redis.call('TYPE', KEYS[4]).ok == 'hash'
  ) then
    return false
  end
  if redis.call('HGET', KEYS[4], '__schema') ~= 'v1' then
    return false
  end
  for index = 1, 4 do
    if tonumber(redis.call('PEXPIRETIME', KEYS[index])) ~= expires_at_ms then
      return false
    end
  end
  return true
end

local function redis_now_ms()
  local time = redis.call('TIME')
  return (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
end

local function secure_equal(left, right)
  if type(left) ~= 'string' or type(right) ~= 'string' then
    return false
  end
  if string.len(left) ~= 64 or string.len(right) ~= 64 then
    return false
  end

  local different = 0
  for index = 1, 64 do
    if string.byte(left, index) ~= string.byte(right, index) then
      different = 1
    end
  end
  return different == 0
end

local function active_expiry(now_ms)
  if redis.call('EXISTS', KEYS[1]) == 0 then
    return nil
  end
  local expires_at_ms = tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs') or '0')
  if expires_at_ms <= now_ms then
    return nil
  end
  return expires_at_ms
end

local function hard_expiry(expires_at_ms, now_ms)
  local hard_expires_at_ms = tonumber(redis.call('HGET', KEYS[1], 'hardExpiresAtMs') or '0')
  if hard_expires_at_ms < expires_at_ms or hard_expires_at_ms <= now_ms then
    return nil
  end
  return hard_expires_at_ms
end
`;

const LUA_APPEND_VALIDATION = String.raw`
local function validate_append(role, kind, decision)
  if kind == 'comment' then
    return 'ok'
  end

  local waiting_on = redis.call('HGET', KEYS[1], 'waitingOn') or ''
  local pending_action = redis.call('HGET', KEYS[1], 'pendingAction') or ''
  if waiting_on ~= role then
    return 'not_your_turn'
  end

  local valid =
    (pending_action == 'provide_context' and kind == 'response') or
    ((pending_action == 'perform_work' or pending_action == 'make_changes') and kind == 'result' and role == 'agent') or
    (pending_action == 'review_result' and kind == 'review_decision' and role == 'human' and
      (decision == 'accept' or decision == 'request_changes'))

  if not valid then
    return 'invalid_transition'
  end
  return 'ok'
end
`;

const LUA_APPEND_IDEMPOTENCY = String.raw`
local function existing_append_receipt(key_digest, request_digest)
  local receipt_raw = redis.call('HGET', KEYS[4], key_digest)
  if not receipt_raw then
    return nil, nil
  end
  local decoded, receipt = pcall(cjson.decode, receipt_raw)
  if not decoded or type(receipt) ~= 'table' then
    return 'corrupt_state', nil
  end
  if not secure_equal(receipt.requestDigest, request_digest) then
    return 'idempotency_conflict', nil
  end
  if type(receipt.entryId) ~= 'string' or type(receipt.resultingVersion) ~= 'number' or
     type(receipt.expiresAtMs) ~= 'number' then
    return 'corrupt_state', nil
  end
  return 'replayed', receipt
end
`;

export const VALKEY_CREATE_RAISE_SCRIPT = String.raw`
local meta = cjson.decode(ARGV[1])
local entry = cjson.decode(ARGV[2])
local owner = cjson.decode(ARGV[3])
local target = cjson.decode(ARGV[4])
local attachments = cjson.decode(ARGV[5])
local time = redis.call('TIME')
local now_ms = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local remaining_hard_ttl_ms = tonumber(ARGV[7])
if not remaining_hard_ttl_ms or remaining_hard_ttl_ms <= 0 then
  return {'invalid_retention'}
end
local hard_expires_at_ms = now_ms + remaining_hard_ttl_ms
local expires_at_ms = math.min(now_ms + tonumber(ARGV[6]), hard_expires_at_ms)

if redis.call('EXISTS', KEYS[1], KEYS[2], KEYS[3], KEYS[4]) ~= 0 then
  return {'duplicate_raise'}
end

redis.call(
  'HSET', KEYS[1],
  'titleEnvelope', meta.titleEnvelope,
  'origin', meta.origin,
  'lifecycle', 'open',
  'version', '1',
  'createdAt', meta.createdAt,
  'updatedAt', meta.createdAt,
  'hardExpiresAtMs', tostring(hard_expires_at_ms),
  'expiresAtMs', tostring(expires_at_ms),
  'waitingOn', meta.waitingOn,
  'pendingAction', meta.pendingAction,
  'pendingActionId', meta.pendingActionId,
  'entry:' .. entry.id, '1'
)

redis.call(
  'XADD', KEYS[2], '*',
  'id', entry.id,
  'authorRole', entry.authorRole,
  'kind', entry.kind,
  'bodyEnvelope', entry.bodyEnvelope,
  'urlEnvelope', entry.urlEnvelope,
  'decisionEnvelope', entry.decisionEnvelope,
  'createdAt', entry.createdAt,
  'attachments', entry.attachmentsJson
)

redis.call('HSET', KEYS[3], owner.id, ARGV[3], target.id, ARGV[4])
redis.call('HSET', KEYS[4], '__schema', 'v1')
for _, attachment in ipairs(attachments) do
  redis.call('HSET', KEYS[1], 'attachment:' .. attachment.id, cjson.encode(attachment))
end

redis.call('PEXPIREAT', KEYS[1], expires_at_ms)
redis.call('PEXPIREAT', KEYS[2], expires_at_ms)
redis.call('PEXPIREAT', KEYS[3], expires_at_ms)
redis.call('PEXPIREAT', KEYS[4], expires_at_ms)
return {'ok'}
`;

export const VALKEY_INSPECT_CLAIM_SCRIPT = `${LUA_AUTH_HELPERS}
local now_ms = redis_now_ms()
local expires_at_ms = active_expiry(now_ms)
if not expires_at_ms then
  return {'invalid_capability'}
end
if not has_complete_bundle(expires_at_ms) then
  return {'corrupt_state'}
end
local hard_expires_at_ms = hard_expiry(expires_at_ms, now_ms)
if not hard_expires_at_ms then
  return {'corrupt_state'}
end

local claim_raw = redis.call('HGET', KEYS[2], ARGV[2])
if not claim_raw then
  return {'invalid_capability'}
end
local claim = cjson.decode(claim_raw)
if claim.kind ~= 'claim' or not secure_equal(claim.secretDigest, ARGV[3]) then
  return {'invalid_capability'}
end
if ARGV[5] ~= '' and claim.role ~= ARGV[5] then
  return {'wrong_role', claim.role}
end

if claim.consumedAt == '' then
  if claim.contentKeyEnvelope == '' then
    return {'incomplete_claim'}
  end
  return {'new', claim_raw, tostring(expires_at_ms), tostring(hard_expires_at_ms)}
end

if ARGV[6] == '' or claim.exchangeDigest == '' or claim.exchangeMode ~= ARGV[4] or
   not secure_equal(claim.exchangeDigest, ARGV[6]) then
  return {'invalid_capability'}
end
local session_raw = redis.call('HGET', KEYS[2], claim.sessionCapabilityId)
if not session_raw then
  return {'incomplete_claim'}
end
local session = cjson.decode(session_raw)
if session.kind ~= 'session' or session.role ~= claim.role or session.contentKeyEnvelope == '' then
  return {'incomplete_claim'}
end
return {
  'replay', claim.role, session.id, session.secretDigest, tostring(expires_at_ms),
  tostring(hard_expires_at_ms)
}
`;

export const VALKEY_COMMIT_CLAIM_SCRIPT = `${LUA_AUTH_HELPERS}
local now_ms = redis_now_ms()
local expires_at_ms = active_expiry(now_ms)
if not expires_at_ms then
  return {'invalid_capability'}
end
if not has_complete_bundle(expires_at_ms) then
  return {'corrupt_state'}
end
local hard_expires_at_ms = hard_expiry(expires_at_ms, now_ms)
if not hard_expires_at_ms then
  return {'corrupt_state'}
end

local claim_raw = redis.call('HGET', KEYS[2], ARGV[2])
if not claim_raw then
  return {'invalid_capability'}
end
local claim = cjson.decode(claim_raw)
if claim.kind ~= 'claim' or not secure_equal(claim.secretDigest, ARGV[3]) then
  return {'invalid_capability'}
end
if ARGV[5] ~= '' and claim.role ~= ARGV[5] then
  return {'wrong_role', claim.role}
end

if claim.consumedAt ~= '' then
  if ARGV[6] == '' or claim.exchangeDigest == '' or claim.exchangeMode ~= ARGV[4] or
     not secure_equal(claim.exchangeDigest, ARGV[6]) then
    return {'invalid_capability'}
  end
  local stored_session_raw = redis.call('HGET', KEYS[2], claim.sessionCapabilityId)
  if not stored_session_raw then
    return {'incomplete_claim'}
  end
  local stored_session = cjson.decode(stored_session_raw)
  if stored_session.kind ~= 'session' or stored_session.role ~= claim.role or
     stored_session.contentKeyEnvelope == '' then
    return {'incomplete_claim'}
  end
  return {
    'replay', claim.role, stored_session.id, stored_session.secretDigest,
    stored_session.contentKeyEnvelope, tostring(expires_at_ms), tostring(hard_expires_at_ms)
  }
end

local session = cjson.decode(ARGV[7])
if session.kind ~= 'session' or session.role ~= claim.role or
   redis.call('HEXISTS', KEYS[2], session.id) == 1 then
  return {'invalid_session'}
end

redis.call('HSET', KEYS[2], session.id, ARGV[7])
claim.consumedAt = tostring(now_ms)
claim.contentKeyEnvelope = ''
claim.exchangeDigest = ARGV[6]
claim.exchangeMode = ARGV[4]
claim.sessionCapabilityId = session.id
redis.call('HSET', KEYS[2], claim.id, cjson.encode(claim))

return {
  'new', claim.role, session.id, session.secretDigest,
  session.contentKeyEnvelope, tostring(expires_at_ms), tostring(hard_expires_at_ms)
}
`;

export const VALKEY_GET_RAISE_SCRIPT = `${LUA_AUTH_HELPERS}
local function valid_stream_id(value)
  if type(value) ~= 'string' or string.len(value) > 41 then
    return false
  end
  local milliseconds, sequence = string.match(value, '^(%d+)%-(%d+)$')
  if not milliseconds or not sequence then
    return false
  end
  if (string.len(milliseconds) > 1 and string.sub(milliseconds, 1, 1) == '0') or
     (string.len(sequence) > 1 and string.sub(sequence, 1, 1) == '0') then
    return false
  end
  local max_uint64 = '18446744073709551615'
  if string.len(milliseconds) > 20 or string.len(sequence) > 20 or
     (string.len(milliseconds) == 20 and milliseconds > max_uint64) or
     (string.len(sequence) == 20 and sequence > max_uint64) then
    return false
  end
  return true
end

local now_ms = redis_now_ms()
local expires_at_ms = active_expiry(now_ms)
if not expires_at_ms then
  return {'unauthorized'}
end
if not has_complete_bundle(expires_at_ms) then
  return {'corrupt_state'}
end

local session_raw = redis.call('HGET', KEYS[2], ARGV[2])
if not session_raw then
  return {'unauthorized'}
end
local session = cjson.decode(session_raw)
if session.kind ~= 'session' or not secure_equal(session.secretDigest, ARGV[3]) or
   session.contentKeyEnvelope == '' then
  return {'unauthorized'}
end

local requested_cursor = ARGV[4] or ''
if requested_cursor ~= '' and not valid_stream_id(requested_cursor) then
  return {'invalid_cursor'}
end

local first = redis.call('XRANGE', KEYS[3], '-', '+', 'COUNT', 1)
local last = redis.call('XREVRANGE', KEYS[3], '+', '-', 'COUNT', 1)
if #first ~= 1 or #last ~= 1 then
  return {'corrupt_state'}
end

local entries_mode = 'snapshot'
local entries
if requested_cursor == '' then
  entries = redis.call('XRANGE', KEYS[3], '-', '+')
else
  local before_or_equal = redis.call('XREVRANGE', KEYS[3], requested_cursor, '-', 'COUNT', 1)
  local after_or_equal = redis.call('XRANGE', KEYS[3], requested_cursor, '+', 'COUNT', 1)
  if #before_or_equal == 0 or #after_or_equal == 0 then
    entries = redis.call('XRANGE', KEYS[3], '-', '+')
  else
    entries_mode = 'delta'
    entries = redis.call('XRANGE', KEYS[3], '(' .. requested_cursor, '+')
  end
end

return {
  'ok', session_raw, tostring(expires_at_ms),
  redis.call('HGETALL', KEYS[1]),
  last[1][1], entries_mode, entries
}
`;

export const VALKEY_PREFLIGHT_APPEND_SCRIPT = `${LUA_AUTH_HELPERS}
${LUA_APPEND_VALIDATION}
${LUA_APPEND_IDEMPOTENCY}
local now_ms = redis_now_ms()
local expires_at_ms = active_expiry(now_ms)
if not expires_at_ms then
  return {'unauthorized'}
end
if not has_complete_bundle(expires_at_ms) then
  return {'corrupt_state'}
end

local session_raw = redis.call('HGET', KEYS[2], ARGV[2])
if not session_raw then
  return {'unauthorized'}
end
local session = cjson.decode(session_raw)
if session.kind ~= 'session' or not secure_equal(session.secretDigest, ARGV[3]) or
   session.contentKeyEnvelope == '' then
  return {'unauthorized'}
end

local receipt_status, receipt = existing_append_receipt(ARGV[7], ARGV[8])
if receipt_status == 'idempotency_conflict' then
  return {'idempotency_conflict'}
elseif receipt_status == 'corrupt_state' then
  return {'corrupt_state'}
elseif receipt_status == 'replayed' then
  return {
    'replayed', receipt.entryId, tostring(receipt.resultingVersion),
    tostring(receipt.expiresAtMs)
  }
end

if redis.call('HGET', KEYS[1], 'lifecycle') ~= 'open' then
  return {'raise_closed'}
end
if tonumber(redis.call('HGET', KEYS[1], 'version') or '0') ~= tonumber(ARGV[4]) then
  return {'state_conflict'}
end

local transition = validate_append(session.role, ARGV[5], ARGV[6])
if transition ~= 'ok' then
  return {transition}
end
return {'ok', session_raw, tostring(expires_at_ms)}
`;

export const VALKEY_APPEND_ENTRY_SCRIPT = `${LUA_AUTH_HELPERS}
${LUA_APPEND_VALIDATION}
${LUA_APPEND_IDEMPOTENCY}
local now_ms = redis_now_ms()
local expires_at_ms = active_expiry(now_ms)
if not expires_at_ms then
  return {'unauthorized'}
end
if not has_complete_bundle(expires_at_ms) then
  return {'corrupt_state'}
end

local session_raw = redis.call('HGET', KEYS[2], ARGV[2])
if not session_raw then
  return {'unauthorized'}
end
local session = cjson.decode(session_raw)
if session.kind ~= 'session' or not secure_equal(session.secretDigest, ARGV[3]) or
   session.contentKeyEnvelope == '' then
  return {'unauthorized'}
end

local receipt_status, receipt = existing_append_receipt(ARGV[12], ARGV[13])
if receipt_status == 'idempotency_conflict' then
  return {'idempotency_conflict'}
elseif receipt_status == 'corrupt_state' then
  return {'corrupt_state'}
elseif receipt_status == 'replayed' then
  return {
    'replayed', receipt.entryId, tostring(receipt.resultingVersion),
    tostring(receipt.expiresAtMs)
  }
end

if redis.call('HGET', KEYS[1], 'lifecycle') ~= 'open' then
  return {'raise_closed'}
end
if tonumber(redis.call('HGET', KEYS[1], 'version') or '0') ~= tonumber(ARGV[4]) then
  return {'state_conflict'}
end

local entry = cjson.decode(ARGV[7])
local transition = validate_append(session.role, entry.kind, ARGV[6])
if transition ~= 'ok' then
  return {transition}
end
if redis.call('HEXISTS', KEYS[1], 'entry:' .. entry.id) == 1 then
  return {'duplicate_entry'}
end

local attachments = cjson.decode(ARGV[8])
for _, attachment in ipairs(attachments) do
  if redis.call('HEXISTS', KEYS[1], 'attachment:' .. attachment.id) == 1 then
    return {'duplicate_attachment'}
  end
end

local hard_expires_at_ms = tonumber(redis.call('HGET', KEYS[1], 'hardExpiresAtMs'))
if not hard_expires_at_ms or hard_expires_at_ms < expires_at_ms or hard_expires_at_ms <= now_ms then
  return {'corrupt_state'}
end

local lifecycle = 'open'
local waiting_on = redis.call('HGET', KEYS[1], 'waitingOn') or ''
local pending_action = redis.call('HGET', KEYS[1], 'pendingAction') or ''
local pending_action_id = redis.call('HGET', KEYS[1], 'pendingActionId') or ''

if entry.kind == 'response' then
  waiting_on = 'agent'
  pending_action = 'perform_work'
  pending_action_id = ARGV[9]
elseif entry.kind == 'result' then
  waiting_on = 'human'
  pending_action = 'review_result'
  pending_action_id = ARGV[9]
elseif entry.kind == 'review_decision' and ARGV[6] == 'request_changes' then
  waiting_on = 'agent'
  pending_action = 'make_changes'
  pending_action_id = ARGV[9]
elseif entry.kind == 'review_decision' and ARGV[6] == 'accept' then
  lifecycle = 'resolved'
  waiting_on = ''
  pending_action = ''
  pending_action_id = ''
end

local next_expires_at_ms
if entry.kind == 'review_decision' and ARGV[6] == 'accept' then
  next_expires_at_ms = math.min(expires_at_ms, now_ms + tonumber(ARGV[11]))
else
  next_expires_at_ms = math.min(hard_expires_at_ms, now_ms + tonumber(ARGV[10]))
end
local resulting_version = tonumber(ARGV[4]) + 1
local receipt_json = cjson.encode({
  requestDigest = ARGV[13],
  entryId = entry.id,
  resultingVersion = resulting_version,
  expiresAtMs = next_expires_at_ms
})

redis.call(
  'XADD', KEYS[3], '*',
  'id', entry.id,
  'authorRole', session.role,
  'kind', entry.kind,
  'bodyEnvelope', entry.bodyEnvelope,
  'urlEnvelope', entry.urlEnvelope,
  'decisionEnvelope', entry.decisionEnvelope,
  'createdAt', entry.createdAt,
  'attachments', entry.attachmentsJson
)
redis.call('HSET', KEYS[1], 'entry:' .. entry.id, '1')
for _, attachment in ipairs(attachments) do
  attachment.authorRole = session.role
  redis.call('HSET', KEYS[1], 'attachment:' .. attachment.id, cjson.encode(attachment))
end

redis.call(
  'HSET', KEYS[1],
  'lifecycle', lifecycle,
  'waitingOn', waiting_on,
  'pendingAction', pending_action,
  'pendingActionId', pending_action_id,
  'version', tostring(resulting_version),
  'updatedAt', entry.createdAt,
  'expiresAtMs', tostring(next_expires_at_ms)
)
redis.call('HSET', KEYS[4], ARGV[12], receipt_json)
redis.call('PEXPIREAT', KEYS[1], next_expires_at_ms)
redis.call('PEXPIREAT', KEYS[2], next_expires_at_ms)
redis.call('PEXPIREAT', KEYS[3], next_expires_at_ms)
redis.call('PEXPIREAT', KEYS[4], next_expires_at_ms)
return {'committed', entry.id, tostring(resulting_version), tostring(next_expires_at_ms)}
`;

export const VALKEY_GET_ATTACHMENT_SCRIPT = `${LUA_AUTH_HELPERS}
local now_ms = redis_now_ms()
local expires_at_ms = active_expiry(now_ms)
if not expires_at_ms then
  return {'unauthorized'}
end
if not has_complete_bundle(expires_at_ms) then
  return {'corrupt_state'}
end

local session_raw = redis.call('HGET', KEYS[2], ARGV[2])
if not session_raw then
  return {'unauthorized'}
end
local session = cjson.decode(session_raw)
if session.kind ~= 'session' or not secure_equal(session.secretDigest, ARGV[3]) or
   session.contentKeyEnvelope == '' then
  return {'unauthorized'}
end

local attachment_raw = redis.call('HGET', KEYS[1], 'attachment:' .. ARGV[4])
if not attachment_raw then
  return {'not_found'}
end
return {'ok', session_raw, tostring(expires_at_ms), attachment_raw}
`;
