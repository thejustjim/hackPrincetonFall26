// Clarity - base station receiver (Inland ESP32 Core Board, plugged into the Pi or laptop)
// Prints every reading from the tank as one JSON line on USB serial (115200), with "rssi" added.
// Any line the Pi writes to this serial port is broadcast back to the tank (AI commands).
//
// Arduino IDE: Boards Manager > "esp32 by Espressif" (3.x). Board: "ESP32 Dev Module".
// If upload hangs on "Connecting...", hold the BOOT button until it starts.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#define CHANNEL 1
#define USE_LR  0   // must match the node

uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// small queue so readings that arrive close together are not lost
#define QN 6
char q[QN][250];
int qlen[QN], qrssi[QN];
volatile int qHead = 0, qTail = 0;

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  int rssi = info->rx_ctrl ? info->rx_ctrl->rssi : 0;
#else
void onRecv(const uint8_t* mac, const uint8_t* data, int len) {
  int rssi = 0;
#endif
  int next = (qHead + 1) % QN;
  if (next == qTail || len <= 0 || len >= 250) return;   // full or bad
  memcpy(q[qHead], data, len); q[qHead][len] = 0;
  qlen[qHead] = len; qrssi[qHead] = rssi;
  qHead = next;
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(CHANNEL, WIFI_SECOND_CHAN_NONE);
#if USE_LR
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR);
#endif
  if (esp_now_init() != ESP_OK) { Serial.println("{\"type\":\"error\",\"msg\":\"esp-now init failed\"}"); return; }
  esp_now_register_recv_cb(onRecv);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BCAST, 6);
  peer.channel = CHANNEL;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
  Serial.println("{\"type\":\"receiver_ready\"}");
}

char line[250];
int n = 0;

void loop() {
  // radio -> USB, adding rssi before the closing brace
  while (qTail != qHead) {
    char* s = q[qTail];
    int len = qlen[qTail];
    while (len > 0 && (s[len - 1] == '\n' || s[len - 1] == '\r' || s[len - 1] == ' ')) s[--len] = 0;
    if (len > 1 && s[len - 1] == '}') {
      s[len - 1] = 0;
      Serial.print(s); Serial.print(",\"rssi\":"); Serial.print(qrssi[qTail]); Serial.println("}");
    } else {
      Serial.println(s);
    }
    qTail = (qTail + 1) % QN;
  }
  // USB (Pi) -> radio
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (n > 0) { line[n] = 0; esp_now_send(BCAST, (uint8_t*)line, n); }
      n = 0;
    } else if (n < (int)sizeof(line) - 1) line[n++] = c;
  }
}
