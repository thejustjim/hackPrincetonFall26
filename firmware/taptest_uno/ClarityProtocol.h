#ifndef CLARITY_PROTOCOL_H
#define CLARITY_PROTOCOL_H

// Kept identical in all three sketch folders so each opens directly in Arduino IDE.
// This protocol is a flat JSON object, without escaped strings or nested values.
// Reject malformed/ambiguous objects before using any field to move hardware.
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>

namespace ClarityProtocol {
struct Token { const char* p; size_t n; bool quoted; };
inline bool eq(const Token& t, const char* s) { return strlen(s) == t.n && !memcmp(t.p, s, t.n); }
inline const char* ws(const char* p) { while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p; return p; }
inline bool quoted(const char*& p, Token& t) {
  if (*p++ != '"') return false;
  t.p = p; t.quoted = true;
  while (*p && *p != '"') { if ((unsigned char)*p < 32 || *p == '\\') return false; ++p; }
  if (*p != '"') return false;
  t.n = p - t.p; ++p; return true;
}
inline bool number(const Token& t) {
  if (t.quoted || !t.n) return false;
  const char* p = t.p; const char* end = p + t.n;
  if (*p == '-') { if (++p == end) return false; }
  if (*p == '0') ++p;
  else { if (*p < '1' || *p > '9') return false; while (p != end && *p >= '0' && *p <= '9') ++p; }
  if (p != end && *p == '.') { ++p; const char* first = p; while (p != end && *p >= '0' && *p <= '9') ++p; if (p == first) return false; }
  if (p != end && (*p == 'e' || *p == 'E')) {
    ++p; if (p != end && (*p == '+' || *p == '-')) ++p;
    const char* first = p; while (p != end && *p >= '0' && *p <= '9') ++p; if (p == first) return false;
  }
  return p == end;
}
inline bool field(const char*& p, Token& key, Token& value) {
  p = ws(p); if (*p != '"' || !quoted(p, key)) return false;
  p = ws(p); if (*p++ != ':') return false;
  p = ws(p);
  if (*p == '"') { if (!quoted(p, value)) return false; }
  else {
    value.p = p; value.quoted = false;
    while (*p && *p != ',' && *p != '}' && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') ++p;
    value.n = p - value.p;
    if (!number(value) && !eq(value, "true") && !eq(value, "false") && !eq(value, "null")) return false;
  }
  p = ws(p); return true;
}
class Object {
  const char* text;
  bool good;
public:
  explicit Object(const char* s): text(s), good(false) {
    if (!s) return;
    const char* first = ws(s); if (*first++ != '{') return;
    const char* p = ws(first);
    if (*p == '}') { good = !*ws(p + 1); return; }
    unsigned fields = 0;
    for (;;) {
      Token key, value; const char* here = p;
      if (++fields > 20 || !field(p, key, value)) return;
      // Duplicate keys must never have first-value/last-value interpretations at different hops.
      const char* prev = ws(first);
      while (prev < here) {
        Token k, v; if (!field(prev, k, v)) return;
        if (k.n == key.n && !memcmp(k.p, key.p, k.n)) return;
        if (*prev != ',') return; prev = ws(prev + 1);
      }
      if (*p == '}') { good = !*ws(p + 1); return; }
      if (*p++ != ',') return;
      p = ws(p); if (*p == '}') return;
    }
  }
  bool valid() const { return good; }
  bool get(const char* name, Token& out) const {
    if (!good) return false;
    const char* p = ws(ws(text) + 1);
    while (*p != '}') {
      Token k, v; if (!field(p, k, v)) return false;
      if (eq(k, name)) { out = v; return true; }
      if (*p == '}') break;
      p = ws(p + 1);
    }
    return false;
  }
  bool has(const char* name) const { Token t; return get(name, t); }
  bool string(const char* name, char* out, size_t capacity) const {
    Token t; if (!get(name, t) || !t.quoted || t.n >= capacity) return false;
    memcpy(out, t.p, t.n); out[t.n] = 0; return true;
  }
  bool textIs(const char* name, const char* value) const { Token t; return get(name, t) && t.quoted && eq(t, value); }
  bool uint32(const char* name, uint32_t& value) const {
    Token t; if (!get(name, t) || t.quoted || !t.n) return false;
    uint32_t n = 0;
    for (size_t i = 0; i < t.n; ++i) {
      if (t.p[i] < '0' || t.p[i] > '9') return false;
      uint32_t d = t.p[i] - '0'; if (n > (UINT32_MAX - d) / 10) return false;
      n = n * 10 + d;
    }
    value = n; return true;
  }
  bool numeric(const char* name) const { Token t; return get(name, t) && number(t); }
  bool flag(const char* name) const {
    Token t; return get(name, t) && !t.quoted && (eq(t, "0") || eq(t, "1") || eq(t, "true") || eq(t, "false"));
  }
};
inline bool identifier(const char* s) {
  if (!*s) return false;
  for (; *s; ++s) if (!((*s >= 'a' && *s <= 'z') || (*s >= 'A' && *s <= 'Z') || (*s >= '0' && *s <= '9') || *s == '-' || *s == '_')) return false;
  return true;
}
inline bool node(const Object& j, char* id, size_t capacity) { return j.string("node", id, capacity) && identifier(id); }
struct Command {
  char node[24], filter[10], session[33];
  uint32_t test, seq;
  bool identity;
};
inline int filterCode(const char* s) {
  return !strcmp(s, "NONE") ? 0 : !strcmp(s, "ZEROWATER") ? 1 : !strcmp(s, "BRITA") ? 2 : !strcmp(s, "RETEST") ? 3 : -1;
}
inline bool command(const char* text, Command& c) {
  Object j(text); c.identity = false;
  if (!j.valid() || !j.textIs("cmd", "filter") || !node(j, c.node, sizeof(c.node)) ||
      !j.uint32("test", c.test) || c.test > 65535 || !j.string("filter", c.filter, sizeof(c.filter)) || filterCode(c.filter) < 0) return false;
  if (j.has("session") != j.has("seq")) return false;
  if (j.has("session")) {
    if (!j.string("session", c.session, sizeof(c.session)) || !identifier(c.session) || !j.uint32("seq", c.seq)) return false;
    c.identity = true;
  }
  return true;
}
inline bool commandFor(const char* text, const char* wantedNode, uint16_t test, int& filter) {
  Command c;
  if (!command(text, c) || strcmp(c.node, wantedNode) || c.test != test) return false;
  filter = filterCode(c.filter); return true;
}
struct Reading {
  char node[24], session[33];
  uint32_t test, seq;
  bool before, identity;
};
inline bool reading(const char* text, Reading& r) {
  Object j(text); r.identity = false;
  if (!j.valid() || j.has("cmd") || !node(j, r.node, sizeof(r.node)) || !j.uint32("test", r.test) || r.test > 65535 ||
      (!j.textIs("phase", "before") && !j.textIs("phase", "after")) || !j.numeric("tds") || !j.numeric("ph") || !j.numeric("clarity")) return false;
  if (!j.textIs("verdict", "SAFE") && !j.textIs("verdict", "HIGH_TDS") && !j.textIs("verdict", "CLOUDY") && !j.textIs("verdict", "PH_WARN")) return false;
  if (!j.textIs("filter", "NONE") && !j.textIs("filter", "ZEROWATER") && !j.textIs("filter", "BRITA")) return false;
  if ((j.has("ask") && !j.flag("ask")) || (j.has("ph_est") && !j.flag("ph_est"))) return false;
  if (j.has("session") != j.has("seq")) return false;
  if (j.has("session")) {
    if (!j.string("session", r.session, sizeof(r.session)) || !identifier(r.session) || !j.uint32("seq", r.seq)) return false;
    r.identity = true;
  }
  r.before = j.textIs("phase", "before"); return true;
}
// Receiver command routing must not move backwards when radio retries arrive late.
// Keep four retired boot IDs too, so a recent old-boot replay cannot replace the
// current target. Readings still reach gateway deduplication regardless of this cursor.
struct ReadingCursor {
  Reading latest;
  bool have;
  char retired[4][33];
  uint8_t retiredCount, retiredNext;
  ReadingCursor(): have(false), retiredCount(0), retiredNext(0) {}
  bool observe(const Reading& incoming) {
    if (have) {
      if (strcmp(incoming.node, latest.node)) return false;
      if (latest.identity) {
        if (!incoming.identity) return false;
        if (!strcmp(incoming.session, latest.session)) {
          if (incoming.seq <= latest.seq) return false;
        } else {
          for (uint8_t i = 0; i < retiredCount; ++i) if (!strcmp(incoming.session, retired[i])) return false;
          strcpy(retired[retiredNext], latest.session);
          if (retiredCount < 4) ++retiredCount;
          retiredNext = (retiredNext + 1) % 4;
        }
      }
    }
    latest = incoming; have = true; return true;
  }
};
inline bool frameReading(const char* input, const char* wantedNode, const char* session, uint32_t seq,
                         uint32_t senderMs, char* output, size_t capacity) {
  Reading r; Object j(input);
  if (!reading(input, r) || strcmp(r.node, wantedNode) || r.identity || j.has("sender_ms") ||
      !identifier(session) || strlen(session) > 32 || capacity > 250) return false;
  const char* end = input + strlen(input);
  while (end > input && (end[-1] == ' ' || end[-1] == '\r' || end[-1] == '\n' || end[-1] == '\t')) --end;
  int n = snprintf(output, capacity, "%.*s,\"session\":\"%s\",\"seq\":%lu,\"sender_ms\":%lu}",
                   (int)(end - input - 1), input, session, (unsigned long)seq, (unsigned long)senderMs);
  return n > 0 && (size_t)n < capacity && n < 250;
}
inline bool commandMatches(const Command& c, const Reading& r) {
  return r.before && !strcmp(c.node, r.node) && c.test == r.test &&
    (r.identity ? c.identity && !strcmp(c.session, r.session) && c.seq == r.seq : !c.identity);
}
} // namespace ClarityProtocol
#endif
