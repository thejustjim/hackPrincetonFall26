// Clarity - tank radio node (Adafruit HUZZAH32 Feather)
// Uno D3 -> divider -> Feather RX (GPIO16). Feather TX (GPIO17) -> Uno D9.
// Validated readings are broadcast with a boot session and sequence identity.
// Only commands for this node's latest before-reading are passed back to the Uno.
// Set NODE_ID to the SAME value as the Uno; give every real tank a different ID.
// Arduino IDE: "esp32 by Espressif" (3.x), board "Adafruit ESP32 Feather".

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <esp_system.h>
#include "ClarityProtocol.h"

#define CHANNEL 1
#define USE_LR  0   // Must match the receiver. Try after the basic link works.
#define LED_PIN 13
#define NODE_ID "tank-01"

uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
struct CommandFrame { char text[250]; };
QueueHandle_t cmdQ;
char session[17];
uint32_t nextSeq = 0;
ClarityProtocol::Reading latest;
bool haveReading = false;

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
#else
void onRecv(const uint8_t* mac, const uint8_t* data, int len) {
#endif
  if (!cmdQ || len <= 0 || len >= 250 || memchr(data, 0, len)) return;
  CommandFrame msg;
  memcpy(msg.text, data, len); msg.text[len] = 0;
  xQueueSend(cmdQ, &msg, 0);                // no serial I/O in the Wi-Fi callback
}

void newSession() {
  snprintf(session, sizeof(session), "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
  nextSeq = 0;
  haveReading = false;
}

void radioSetup() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(CHANNEL, WIFI_SECOND_CHAN_NONE);
#if USE_LR
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR);
#endif
  newSession();                             // RNG has radio entropy after Wi-Fi starts
  if (esp_now_init() != ESP_OK) { Serial.println("ESP-NOW init failed"); return; }
  esp_now_register_recv_cb(onRecv);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BCAST, 6);
  peer.channel = CHANNEL;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, 16, 17);    // RX=16 from Uno, TX=17 to Uno
  pinMode(LED_PIN, OUTPUT);
  cmdQ = xQueueCreate(3, sizeof(CommandFrame));
  radioSetup();
  Serial.print("Clarity node ready, MAC "); Serial.println(WiFi.macAddress());
}

char line[250];
int n = 0;
bool overflow = false;

void loop() {
  // Uno -> radio. Drop overlong lines as a whole, never forward a truncated prefix.
  while (Serial1.available()) {
    char c = Serial1.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[n] = 0;
      char packet[250];
      if (!overflow && n && ClarityProtocol::frameReading(line, NODE_ID, session, nextSeq, millis(), packet, sizeof(packet))) {
        ClarityProtocol::reading(packet, latest);
        haveReading = true;
        // Identity is assigned once per UART reading. A transport retry must resend this
        // exact packet, rather than assigning it a new sequence number.
        esp_err_t r = esp_now_send(BCAST, (uint8_t*)packet, strlen(packet));
        Serial.print(r == ESP_OK ? "sent: " : "send FAILED: "); Serial.println(packet);
        digitalWrite(LED_PIN, HIGH); delay(30); digitalWrite(LED_PIN, LOW);
        if (nextSeq == UINT32_MAX) newSession(); else ++nextSeq;
      } else if (n || overflow) Serial.println("reading rejected: invalid, wrong node or too long");
      n = 0; overflow = false;
    } else if (c == 0 || n >= (int)sizeof(line) - 1) overflow = true;
    else if (!overflow) line[n++] = c;
  }
  // radio -> Uno. Target, test, boot session and sequence must all match the
  // latest reading. A delayed decision for an old pour/reboot cannot move a cup.
  CommandFrame msg;
  while (cmdQ && xQueueReceive(cmdQ, &msg, 0) == pdTRUE) {
    ClarityProtocol::Command cmd;
    if (haveReading && ClarityProtocol::command(msg.text, cmd) && ClarityProtocol::commandMatches(cmd, latest)) {
      Serial1.println(msg.text);
      Serial.print("cmd to Uno: "); Serial.println(msg.text);
      haveReading = false;                  // consume once, so duplicate commands cannot replay
    } else Serial.println("command rejected: invalid or stale target");
  }
}
