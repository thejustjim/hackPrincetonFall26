// Clarity - Arduino Uno main sketch
// Reads pH, TDS and clarity, decides a filter, tips the cup, reports over radio.
//
// Libraries (Arduino IDE > Library Manager): "LiquidCrystal I2C" by Frank de Brabander.
// Servo, Wire, EEPROM, SoftwareSerial are built in.
//
// Pins (matches taptest-wiring-filter.png):
//   A0 pH Po | A1 TDS signal | D7 TDS power | A2 LDR + 10k divider
//   SDA/SCL LCD 0x27 | D4 button (to GND) | D5/D6/D8 RGB via 270R
//   D10 servo signal | D2 stop switch LEFT | D12 stop switch RIGHT (switches to GND)
//   D3 -> 1k -> Feather RX (2k to GND) | D9 <- Feather TX (optional, AI commands)
//
// USB serial monitor at 115200 for calibration. Type "h" for help.

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Servo.h>
#include <SoftwareSerial.h>
#include <EEPROM.h>

// must sit above every function so the IDE's auto-generated prototypes can see it
enum Filter { F_NONE, F_ZERO, F_BRITA };

// ---------------- settings you may need to flip ----------------
#define COMMON_ANODE   0      // 1 if your RGB LED's long leg goes to 5V
#define LEFT_SIGN      (-1)   // flip to 1 if "tip left" turns the cup right
#define TDS_LIMIT      300    // ppm above this -> ZeroWater
#define CLARITY_LIMIT  0.70   // below this -> Brita
#define PH_LOW         6.5
#define PH_HIGH        8.5
// Demo pH: our probe drifts too much without buffer packets, so pH is estimated
// from TDS. Baking soda water is about pH 8.3 at any strength, and it raises TDS a lot.
// Set PH_FROM_TDS to 0 to go back to the real probe once it is calibrated with buffers.
#define PH_FROM_TDS    1
#define PH_TDS_CLEAN   150    // ppm at or below this -> pH 7.0 (plain tap water)
#define PH_TDS_SODA    800    // ppm at or above this -> pH 8.3 (baking soda water)
#define POUR_MS        6000   // how long the cup stays tipped
#define AI_WAIT_MS     8000   // how long to wait for the Pi's AI decision
// "Reflex vs judgment": clear-cut readings are handled instantly by the rules below.
// Only unsure readings (near a limit, two problems at once, or sensor looks wrong) go to the AI.
#define TDS_MARGIN     45     // ppm either side of TDS_LIMIT counts as borderline
#define CLR_MARGIN     0.08   // clarity either side of CLARITY_LIMIT counts as borderline
#define AI_RETEST      9      // waitForAI() result: AI says the reading looks like a sensor problem
#define NODE_ID        "tank-01"

// ---------------- pins ----------------
const uint8_t PIN_PH = A0, PIN_TDS = A1, PIN_LDR = A2;
const uint8_t PIN_TDS_PWR = 7, PIN_BTN = 4;
const uint8_t PIN_R = 5, PIN_G = 6, PIN_B = 8;
const uint8_t PIN_SERVO = 10, PIN_SW_L = 2, PIN_SW_R = 12;

LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo servo;
SoftwareSerial radio(9, 3);  // RX = D9 (from Feather TX), TX = D3 (to Feather RX)

// ---------------- calibration stored in EEPROM ----------------
struct Cal {
  uint16_t magic;
  float phV1, phP1;   // pH point A: voltage, pH
  float phV2, phP2;   // pH point B
  float clarBase;     // LED-on minus LED-off reading with clean water
  int   stopUs;       // pulse where the 360 servo stands still
  int   tipUs;        // speed offset from stopUs while tipping
  float returnScale;  // return time = tip time * this
  uint16_t testNo;
  int   tipMs;        // how long a tip runs if no stop switch is hit (sets the tilt angle)
};
Cal cal;
const uint16_t MAGIC = 0x7A51;

void loadCal() {
  EEPROM.get(0, cal);
  if (cal.magic != MAGIC) {
    cal.magic = MAGIC;
    cal.phV1 = 2.50; cal.phP1 = 7.00;   // typical PH-4502C: ~2.5 V at pH 7
    cal.phV2 = 3.03; cal.phP2 = 4.00;   // ~0.18 V per pH unit
    cal.clarBase = 300;
    cal.stopUs = 1500; cal.tipUs = 80; cal.returnScale = 1.0;
    cal.testNo = 0;
    EEPROM.put(0, cal);
  }
  if (cal.tipMs < 100 || cal.tipMs > 5000) cal.tipMs = 1000;   // new field, safe default
}
void saveCal() { EEPROM.put(0, cal); }

// ---------------- helpers ----------------
const char* filterName(Filter f) { return f == F_ZERO ? "ZEROWATER" : f == F_BRITA ? "BRITA" : "NONE"; }

void led(bool r, bool g, bool b) {
#if COMMON_ANODE
  r = !r; g = !g; b = !b;
#endif
  digitalWrite(PIN_R, r); digitalWrite(PIN_G, g); digitalWrite(PIN_B, b);
}

// average of n readings with the highest and lowest dropped
float readAvg(uint8_t pin, uint8_t n) {
  long sum = 0; int lo = 1023, hi = 0;
  for (uint8_t i = 0; i < n; i++) {
    int v = analogRead(pin);
    sum += v; if (v < lo) lo = v; if (v > hi) hi = v;
    delay(10);
  }
  return (float)(sum - lo - hi) / (n - 2);
}

float phVolts() { return readAvg(PIN_PH, 30) * 5.0 / 1023.0; }

float readPH(int tds) {
#if PH_FROM_TDS
  float x = (float)(tds - PH_TDS_CLEAN) / (PH_TDS_SODA - PH_TDS_CLEAN);
  if (x < 0) x = 0;
  if (x > 1) x = 1;
  return 7.0 + 1.3 * x;
#endif
  float v = phVolts();
  float slope = (cal.phP2 - cal.phP1) / (cal.phV2 - cal.phV1);
  return cal.phP1 + slope * (v - cal.phV1);
}

int readTDS() {
  digitalWrite(PIN_TDS_PWR, HIGH);
  delay(150);
  float v = readAvg(PIN_TDS, 30) * 5.0 / 1023.0;
  digitalWrite(PIN_TDS_PWR, LOW);       // off so it does not disturb the pH probe
  float ec = v / 1.0;                   // 25 C assumed, no temperature probe
  float tds = (133.42 * ec * ec * ec - 255.86 * ec * ec + 857.39 * ec) * 0.5;
  if (tds < 0) tds = 0;
  return (int)(tds + 0.5);
}

float clarityRaw() {
  led(0, 0, 0); delay(120);
  float off = readAvg(PIN_LDR, 16);
  led(1, 1, 1); delay(120);
  float on = readAvg(PIN_LDR, 16);
  return fabs(on - off);
}

float readClarity() {
  float c = clarityRaw() / cal.clarBase;
  if (c > 1.0) c = 1.0;
  if (c < 0) c = 0;
  return c;
}

// ---------------- servo (360 continuous, stop switches) ----------------
void servoStop() { servo.writeMicroseconds(cal.stopUs); delay(60); servo.detach(); }

void servoRun(int dir) {  // dir: -1 left, +1 right
  if (!servo.attached()) servo.attach(PIN_SERVO);
  servo.writeMicroseconds(cal.stopUs + dir * LEFT_SIGN * cal.tipUs);  // LEFT_SIGN flips direction
}

// tips the cup to one side, holds, then brings it back upright by time
void tipAndReturn(int dir) {
  uint8_t sw = dir < 0 ? PIN_SW_L : PIN_SW_R;
  unsigned long t0 = millis();
  servoRun(dir);
  while (digitalRead(sw) == HIGH && millis() - t0 < (unsigned long)cal.tipMs) {}
  unsigned long tipTime = millis() - t0;
  servoStop();
  Serial.print(F("tip ms=")); Serial.println(tipTime);
  delay(POUR_MS);
  servoRun(-dir);
  delay((unsigned long)(tipTime * cal.returnScale));
  servoStop();
}

// ---------------- radio ----------------
void sendReading(const char* phase, float ph, int tds, float clr, const char* verdict, Filter f, bool ask) {
  char phs[8], cls[8];
  dtostrf(ph, 1, 2, phs);
  dtostrf(clr, 1, 2, cls);
  // the same line goes to the Feather (radio) and to USB for debugging
  for (uint8_t k = 0; k < 2; k++) {
    Print& out = k == 0 ? (Print&)radio : (Print&)Serial;
    out.print(F("{\"node\":\"" NODE_ID "\",\"test\":")); out.print(cal.testNo);
    out.print(F(",\"phase\":\"")); out.print(phase);
    out.print(F("\",\"ph\":")); out.print(phs);
    out.print(F(",\"tds\":")); out.print(tds);
    out.print(F(",\"clarity\":")); out.print(cls);
    out.print(F(",\"verdict\":\"")); out.print(verdict);
    out.print(F("\",\"filter\":\"")); out.print(filterName(f));
    out.print(F("\",\"ask\":")); out.print(ask ? 1 : 0);
    out.println(F("}"));
  }
}

// waits for {"cmd":"filter","test":N,"filter":"..."} from the Pi; returns -1 if none
int waitForAI() {
  char buf[120]; uint8_t n = 0;
  unsigned long t0 = millis();
  radio.listen();
  while (millis() - t0 < AI_WAIT_MS) {
    while (radio.available()) {
      char c = radio.read();
      if (c == '\n') {
        buf[n] = 0; n = 0;
        if (!strstr(buf, "\"cmd\"")) continue;
        char want[16]; snprintf(want, sizeof want, "\"test\":%u", cal.testNo);
        if (!strstr(buf, want)) continue;
        if (strstr(buf, "ZEROWATER")) return F_ZERO;
        if (strstr(buf, "BRITA")) return F_BRITA;
        if (strstr(buf, "NONE")) return F_NONE;
        if (strstr(buf, "RETEST")) return AI_RETEST;
      } else if (n < sizeof(buf) - 1) buf[n++] = c;
    }
  }
  return -1;
}

// ---------------- main flow ----------------
bool waitingRetest = false;

void showLine(uint8_t row, const __FlashStringHelper* s) {
  lcd.setCursor(0, row); lcd.print(F("                ")); lcd.setCursor(0, row); lcd.print(s);
}

void idleScreen() {
  lcd.clear();
  if (waitingRetest) { lcd.print(F("Pour clean water")); lcd.setCursor(0, 1); lcd.print(F("back, press btn")); led(1, 0, 1); }
  else { lcd.print(F("Clarity ready")); lcd.setCursor(0, 1); lcd.print(F("Pour + press btn")); led(0, 0, 1); }
}

void runTest() {
  const char* phase = waitingRetest ? "after" : "before";
  if (!waitingRetest) { cal.testNo++; saveCal(); }

  lcd.clear(); lcd.print(F("Testing...")); led(1, 1, 1);
  int tds = readTDS();
  float ph = readPH(tds);
  float clr = readClarity();

  const char* verdict = "SAFE"; Filter f = F_NONE;
  if (tds > TDS_LIMIT)               { verdict = "HIGH_TDS"; f = F_ZERO; }
  else if (clr < CLARITY_LIMIT)      { verdict = "CLOUDY";   f = F_BRITA; }
  else if (ph < PH_LOW || ph > PH_HIGH) { verdict = "PH_WARN"; }

  lcd.clear();
  lcd.print(F("pH")); lcd.print(ph, 1); lcd.print(F(" TDS ")); lcd.print(tds);
  lcd.setCursor(0, 1); lcd.print(F("Clr")); lcd.print((int)(clr * 100)); lcd.print(F("% ")); lcd.print(verdict);

  if (waitingRetest) {   // retest done: show result, no tipping
    sendReading(phase, ph, tds, clr, verdict, F_NONE, false);
    bool ok = strcmp(verdict, "SAFE") == 0;
    led(!ok, ok, 0);
    waitingRetest = false;
    delay(6000);
    idleScreen();
    return;
  }

  // Is this an easy call (reflex) or does it need judgment (AI)?
  bool bothBad    = tds > TDS_LIMIT && clr < CLARITY_LIMIT;
  bool nearTds    = abs(tds - TDS_LIMIT) <= TDS_MARGIN;
  bool nearClr    = fabs(clr - CLARITY_LIMIT) <= CLR_MARGIN;
  bool oddSensor  = tds < 5 || clr <= 0.02;          // probe out of water, light path blocked
  bool unsure     = bothBad || nearTds || nearClr || oddSensor;

  sendReading(phase, ph, tds, clr, verdict, f, unsure);
  delay(2500);

  if (unsure) {
    // ask the Pi's AI; fall back to our own rule if it does not answer in time
    led(0, 1, 1);                                   // cyan = AI thinking
    showLine(1, F("Unsure: ask AI.."));
    int ai = waitForAI();
    if (ai == AI_RETEST) {
      led(1, 0, 0);
      showLine(0, F("AI: check probes"));
      showLine(1, F("then test again"));
      delay(6000);
      idleScreen();
      return;
    }
    if (ai >= 0) { f = (Filter)ai; showLine(1, F("AI chose:")); }
    else showLine(1, F("Rule only:"));
  } else {
    showLine(1, F("Clear call:"));                   // instant reflex, AI explains on the dashboard
  }
  lcd.setCursor(11, 1); lcd.print(f == F_ZERO ? F("ZeroW") : f == F_BRITA ? F("Brita") : F("none"));
  delay(1500);

  if (f == F_NONE) {
    bool ok = strcmp(verdict, "SAFE") == 0;
    led(!ok, ok, 0);
    showLine(1, ok ? F("All in range") : F("pH off: see app"));   // in range is not a safety test
    delay(6000);
    idleScreen();
    return;
  }

  led(1, 1, 0);
  showLine(0, f == F_ZERO ? F("-> ZeroWater") : F("-> Brita"));
  showLine(1, F("Filtering..."));
  tipAndReturn(f == F_ZERO ? -1 : +1);   // ZeroWater is on the left
  waitingRetest = true;
  idleScreen();
}

// ---------------- serial calibration console ----------------
void help() {
  Serial.println(F("Commands: v=raw volts | m=measure | a6.86 / b4.00 = pH point at current probe"));
  Serial.println(F("c=clean water clarity baseline | s1500=servo stop us | t80=tip speed | k1.0=return scale | p1000=tip time ms"));
  Serial.println(F("l / r = jog servo 200ms | L / R = full tip test | z = reset test counter"));
}

void console() {
  if (!Serial.available()) return;
  char cmd = Serial.read();
  float val = Serial.parseFloat();
  switch (cmd) {
    case 'h': help(); break;
    case 'v':
      Serial.print(F("pH V=")); Serial.print(phVolts(), 3);
      Serial.print(F(" TDS ppm=")); Serial.print(readTDS());
      Serial.print(F(" clarityRaw=")); Serial.println(clarityRaw());
      break;
    case 'm': {
      int t = readTDS();
      Serial.print(F("pH=")); Serial.print(readPH(t), 2);
      Serial.print(F(" tds=")); Serial.print(t);
      Serial.print(F(" clarity=")); Serial.println(readClarity(), 2);
      break; }
    case 'a': cal.phV1 = phVolts(); cal.phP1 = val; saveCal(); Serial.println(F("pH point A saved")); break;
    case 'b': cal.phV2 = phVolts(); cal.phP2 = val; saveCal(); Serial.println(F("pH point B saved")); break;
    case 'c': cal.clarBase = clarityRaw(); saveCal(); Serial.print(F("clarity base=")); Serial.println(cal.clarBase); break;
    case 's': cal.stopUs = (int)val; saveCal(); servo.attach(PIN_SERVO); servo.writeMicroseconds(cal.stopUs);
              Serial.println(F("holding stop pulse 3s: adjust until it does not creep")); delay(3000); servoStop(); break;
    case 't': cal.tipUs = (int)val; saveCal(); Serial.println(F("tip speed saved")); break;
    case 'k': cal.returnScale = val; saveCal(); Serial.println(F("return scale saved")); break;
    case 'p': cal.tipMs = (int)val; saveCal(); Serial.print(F("tip time ms=")); Serial.println(cal.tipMs); break;
    case 'l': servoRun(-1); delay(200); servoStop(); break;
    case 'r': servoRun(+1); delay(200); servoStop(); break;
    case 'L': tipAndReturn(-1); break;
    case 'R': tipAndReturn(+1); break;
    case 'z': cal.testNo = 0; saveCal(); Serial.println(F("test counter reset")); break;
  }
  if (cmd != '\n' && cmd != '\r') idleScreen();   // put the LED and LCD back to the idle state
}

void setup() {
  Serial.begin(115200);
  radio.begin(9600);
  pinMode(PIN_TDS_PWR, OUTPUT); digitalWrite(PIN_TDS_PWR, LOW);
  pinMode(PIN_BTN, INPUT_PULLUP);
  pinMode(PIN_SW_L, INPUT_PULLUP); pinMode(PIN_SW_R, INPUT_PULLUP);
  pinMode(PIN_R, OUTPUT); pinMode(PIN_G, OUTPUT); pinMode(PIN_B, OUTPUT);
  loadCal();
  lcd.init(); lcd.backlight();
  help();
  idleScreen();
}

void loop() {
  console();
  if (digitalRead(PIN_BTN) == LOW) {
    unsigned long t0 = millis();
    while (digitalRead(PIN_BTN) == LOW) {}
    unsigned long held = millis() - t0;
    if (held < 40) return;                       // bounce
    if (held > 1500) {                           // long press: clean-water baseline
      cal.clarBase = clarityRaw(); saveCal();
      lcd.clear(); lcd.print(F("Clarity baseline")); lcd.setCursor(0, 1); lcd.print(F("saved"));
      delay(1500); idleScreen();
    } else {
      runTest();
    }
  }
}
