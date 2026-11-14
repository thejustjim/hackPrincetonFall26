// Clarity - tank radio node (Adafruit HUZZAH32 Feather)
// Uno D3 -> divider -> Feather RX (GPIO16). Feather TX (GPIO17) -> Uno D9.
// Every line the Uno prints is broadcast over ESP-NOW. Commands from the base
// station (lines containing "cmd") are passed back to the Uno.
//
// Arduino IDE: Boards Manager > "esp32 by Espressif" (3.x). Board: "Adafruit ESP32 Feather".

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#define CHANNEL 1
#define USE_LR  0   // 1 = ESP32 long-range mode. Must match the receiver. Try after basic link works.
#define LED_PIN 13

uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

volatile bool cmdReady = false;
char cmdBuf[250];
int cmdLen = 0;

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
#else
void onRecv(const uint8_t* mac, const uint8_t* data, int len) {
#endif
  if (cmdReady || len <= 0 || len >= (int)sizeof(cmdBuf)) return;
  memcpy(cmdBuf, data, len); cmdBuf[len] = 0; cmdLen = len;
  cmdReady = true;
}

void radioSetup() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(CHANNEL, WIFI_SECOND_CHAN_NONE);
#if USE_LR
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR);
#endif
  if (esp_now_init() != ESP_OK) { Serial.println("ESP-NOW init failed"); return; }
  esp_now_register_recv_cb(onRecv);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BCAST, 6);
  peer.channel = CHANNEL;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
}

void setup() {
  Serial.begin(115200);                       // USB debug
  Serial1.begin(9600, SERIAL_8N1, 16, 17);    // RX=16 (from Uno), TX=17 (to Uno)
  pinMode(LED_PIN, OUTPUT);
  radioSetup();
  Serial.print("Clarity node ready, MAC "); Serial.println(WiFi.macAddress());
}

char line[250];
int n = 0;

void loop() {
  // Uno -> radio
  while (Serial1.available()) {
    char c = Serial1.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (n > 0) {
        line[n] = 0;
        esp_err_t r = esp_now_send(BCAST, (uint8_t*)line, n);
        Serial.print(r == ESP_OK ? "sent: " : "send FAILED: "); Serial.println(line);
        digitalWrite(LED_PIN, HIGH); delay(30); digitalWrite(LED_PIN, LOW);
      }
      n = 0;
    } else if (n < (int)sizeof(line) - 1) line[n++] = c;
  }
  // radio -> Uno (AI commands)
  if (cmdReady) {
    if (strstr(cmdBuf, "\"cmd\"")) {
      Serial1.print(cmdBuf); Serial1.print('\n');
      Serial.print("cmd to Uno: "); Serial.println(cmdBuf);
    }
    cmdReady = false;
  }
}
