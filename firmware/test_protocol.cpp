#include "taptest_uno/ClarityProtocol.h"
#include <assert.h>
#include <string>
#include <random>
using namespace ClarityProtocol;
int main() {
  int f = -1;
  const char* valid = "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"ZEROWATER\"}";
  assert(commandFor(valid,"tank-01",5,f) && f == 1);
  assert(!commandFor(valid,"tank-02",5,f));
  assert(!commandFor(valid,"tank-01",50,f));
  assert(commandFor("{ \"filter\" : \"RETEST\", \"test\" : 5, \"node\" : \"tank-01\", \"cmd\" : \"filter\" }","tank-01",5,f) && f == 3);
  const char* bad[] = {
    "{\"cmd\":\"filter\",\"test\":5,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":50,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"notfilter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":\"5\",\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":true,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5.0,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":05,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"test\":50,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-02\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"MALFORMED\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"BRITA\",}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"BRITA\"}junk",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":65536,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":-5,\"filter\":\"BRITA\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"BRITA\",\"session\":\"a\"}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"BRITA\",\"seq\":1}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"BRITA\",\"session\":\"a\",\"seq\":4294967296}",
    "{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"BRITA\",\"extra\":{}}"
  };
  for (auto text:bad) assert(!commandFor(text,"tank-01",5,f));
  for(size_t i=0;i<strlen(valid);++i) { std::string prefix(valid,i); Command c; assert(!command(prefix.c_str(),c)); }
  const char* raw="{\"node\":\"tank-01\",\"test\":65535,\"phase\":\"before\",\"ph\":14.00,\"tds\":65535,\"clarity\":1.00,\"verdict\":\"HIGH_TDS\",\"filter\":\"ZEROWATER\",\"ask\":1,\"ph_est\":1}";
  char frame[250];
  assert(frameReading(raw,"tank-01","0123456789abcdef",UINT32_MAX,UINT32_MAX,frame,sizeof(frame)));
  assert(strlen(frame)<250);
  const size_t largestFrame = strlen(frame);
  Reading r; assert(reading(frame,r) && r.identity && r.test==65535 && r.seq==UINT32_MAX);
  Object parsed(frame); assert(parsed.flag("ph_est"));
  assert(!frameReading(raw,"tank-02","a",1,1,frame,sizeof(frame)));
  char tooSmall[60]; assert(!frameReading(raw,"tank-01","a",1,1,tooSmall,sizeof(tooSmall)));
  const char* live="{\"node\":\"tank-01\",\"test\":5,\"phase\":\"before\",\"ph\":7.20,\"tds\":295,\"clarity\":0.95,\"verdict\":\"SAFE\",\"filter\":\"NONE\",\"ask\":1,\"ph_est\":1}";
  assert(frameReading(live,"tank-01","boot_a",4,100,frame,sizeof(frame)));
  assert(reading(frame,r));
  Command c;
  assert(command("{\"cmd\":\"filter\",\"node\":\"tank-01\",\"test\":5,\"filter\":\"BRITA\",\"session\":\"boot_a\",\"seq\":4}",c));
  assert(commandMatches(c,r));
  Reading other = r; strcpy(other.node,"tank-02");
  assert(!commandMatches(c,other));
  Command second = c; strcpy(second.node,"tank-02");
  assert(commandMatches(second,other) && !commandMatches(second,r));
  c.seq=3; assert(!commandMatches(c,r)); c.seq=4;
  strcpy(c.session,"boot_old"); assert(!commandMatches(c,r)); strcpy(c.session,"boot_a");
  c.test=50; assert(!commandMatches(c,r)); c.test=5;
  strcpy(c.node,"tank-02"); assert(!commandMatches(c,r)); strcpy(c.node,"tank-01");
  r.before=false; assert(!commandMatches(c,r)); r.before=true;
  c.identity=false; assert(!commandMatches(c,r));
  assert(reading(live,r) && !r.identity && commandMatches(c,r));
  // Actual receiver cursor: delayed/replayed radio frames must never regress
  // the target or reopen a completed reading, including after a node reboot.
  assert(frameReading(live,"tank-01","boot_a",4,100,frame,sizeof(frame)));
  Reading first; assert(reading(frame,first));
  ReadingCursor cursor;
  assert(cursor.observe(first));
  Reading newer = first; newer.seq = 5; newer.before = false;
  assert(cursor.observe(newer));
  assert(!cursor.observe(first) && cursor.latest.seq == 5 && !cursor.latest.before);
  Reading conflicting = newer; conflicting.before = true;
  assert(!cursor.observe(conflicting) && !cursor.latest.before);
  assert(!commandMatches(c,cursor.latest));
  Reading reboot = first; strcpy(reboot.session,"boot_b"); reboot.seq = 0;
  assert(cursor.observe(reboot) && cursor.latest.seq == 0);
  newer.seq = 6;
  assert(!cursor.observe(newer) && !strcmp(cursor.latest.session,"boot_b"));
  Reading legacy = first; legacy.identity = false;
  assert(!cursor.observe(legacy) && cursor.latest.identity);
  Reading wrongNode = reboot; strcpy(wrongNode.node,"tank-02");
  assert(!cursor.observe(wrongNode));
  reboot.seq = 1; assert(cursor.observe(reboot));
  ReadingCursor otherCursor;
  assert(otherCursor.observe(wrongNode));
  assert(!otherCursor.observe(reboot));
  // Exercise bounded malformed wire input as well as the targeted acceptance cases.
  std::mt19937 random(26);
  for(int i=0;i<30000;++i) {
    std::string text; int n=random()%250;
    while(n--) text.push_back((char)(1+random()%126));
    Object j(text.c_str()); Command cmd; Reading read;
    command(text.c_str(),cmd); reading(text.c_str(),read);
  }
  printf("Protocol checks passed; largest normal transport frame: %zu bytes.\n",largestFrame);
}
