// Clarity - base station receiver (Inland ESP32 Core Board, USB to Pi/laptop)
// Validated readings go to USB with RSSI. Commands are unicast to the MAC learned
// from the addressed node's latest reading; unknown/stale targets fail closed.
// Arduino IDE: "esp32 by Espressif" (3.x), board "ESP32 Dev Module".
// If upload hangs on Connecting, hold BOOT until it starts.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include "ClarityProtocol.h"

#define CHANNEL 1
#define USE_LR  0
#define MAX_NODES 16

struct RadioFrame { char text[250]; uint8_t mac[6]; int rssi; };
QueueHandle_t readingsQ;
struct Route { ClarityProtocol::ReadingCursor cursor; uint8_t mac[6]; bool used; };
Route routes[MAX_NODES] = {};

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  if (!info) return;
  const uint8_t* mac = info->src_addr;
  int rssi = info->rx_ctrl ? info->rx_ctrl->rssi : 0;
#else
void onRecv(const uint8_t* mac, const uint8_t* data, int len) {
  int rssi = 0;
#endif
  if (!readingsQ || !mac || len <= 0 || len >= 250 || memchr(data, 0, len)) return;
  RadioFrame msg;
  memcpy(msg.text, data, len); msg.text[len] = 0;
  memcpy(msg.mac, mac, 6); msg.rssi = rssi;
  xQueueSend(readingsQ, &msg, 0);
}

Route* routeFor(const char* node) {
  for (int i = 0; i < MAX_NODES; ++i) if (routes[i].used && !strcmp(routes[i].cursor.latest.node, node)) return &routes[i];
  return NULL;
}

Route* learn(const ClarityProtocol::Reading& reading, const uint8_t* mac) {
  Route* route = routeFor(reading.node);
  if (route && memcmp(route->mac, mac, 6)) {
    Serial.println("# node ID conflict: reading dropped; use a unique ID per tank");
    return NULL;
  }
  if (!route) for (int i = 0; i < MAX_NODES; ++i) if (!routes[i].used) { route = &routes[i]; break; }
  if (!route) { Serial.println("# route table full: reading dropped"); return NULL; }
  // A duplicate, an out-of-order packet or a recent old boot must not regress
  // the command target. It can still be forwarded for the gateway to deduplicate.
  route->cursor.observe(reading);
  memcpy(route->mac, mac, 6); route->used = true;
  return route;
}

bool ensurePeer(const uint8_t* mac) {
  if (esp_now_is_peer_exist(mac)) return true;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6); peer.channel = CHANNEL;
  peer.ifidx = WIFI_IF_STA; peer.encrypt = false;
  return esp_now_add_peer(&peer) == ESP_OK;
}

void setup() {
  Serial.begin(115200);
  readingsQ = xQueueCreate(6, sizeof(RadioFrame));
  WiFi.mode(WIFI_STA); WiFi.disconnect();
  esp_wifi_set_channel(CHANNEL, WIFI_SECOND_CHAN_NONE);
#if USE_LR
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR);
#endif
  if (esp_now_init() != ESP_OK) { Serial.println("{\"type\":\"error\",\"msg\":\"esp-now init failed\"}"); return; }
  esp_now_register_recv_cb(onRecv);
  Serial.println("{\"type\":\"receiver_ready\"}");
}

char line[250];
int n = 0;
bool overflow = false;

void loop() {
  RadioFrame msg;
  while (readingsQ && xQueueReceive(readingsQ, &msg, 0) == pdTRUE) {
    ClarityProtocol::Reading reading;
    if (!ClarityProtocol::reading(msg.text, reading) || !learn(reading, msg.mac)) {
      Serial.println("# radio reading rejected"); continue;
    }
    int len = strlen(msg.text);
    while (len > 0 && (msg.text[len-1] == ' ' || msg.text[len-1] == '\r' || msg.text[len-1] == '\n' || msg.text[len-1] == '\t')) --len;
    msg.text[len-1] = 0;                     // validated closing brace
    Serial.print(msg.text); Serial.print(",\"rssi\":"); Serial.print(msg.rssi); Serial.println("}");
  }
  // USB -> one known node. No broadcast fallback and no forwarding arbitrary JSON.
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[n] = 0;
      ClarityProtocol::Command cmd;
      if (!overflow && n && ClarityProtocol::command(line, cmd)) {
        Route* route = routeFor(cmd.node);
        if (route && ClarityProtocol::commandMatches(cmd, route->cursor.latest) && ensurePeer(route->mac)) {
          esp_err_t result = esp_now_send(route->mac, (uint8_t*)line, n);
          Serial.println(result == ESP_OK ? "# targeted command queued" : "# targeted command send failed");
        } else Serial.println("# command rejected: unknown node or stale reading");
      } else if (n || overflow) Serial.println("# command rejected: invalid JSON or length");
      n = 0; overflow = false;
    } else if (c == 0 || n >= (int)sizeof(line) - 1) overflow = true;
    else if (!overflow) line[n++] = c;
  }
}
