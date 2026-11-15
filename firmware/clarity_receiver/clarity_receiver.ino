#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_mac.h>

typedef struct __attribute__((packed)) {
  uint8_t  node_id;
  uint8_t  id;
  uint16_t tds_ppm;
  uint8_t  ph_x10;
  uint8_t  clarity_pct;
  uint8_t  state;
} ReadingPacket;          // 7 bytes

typedef struct __attribute__((packed)) {
  uint8_t node_id;
  uint8_t id;
  uint8_t filter;
} CommandPacket;          // 3 bytes

const char *FILTER[] = {"NONE", "PUR", "BRITA", "RETEST"};

struct Msg { ReadingPacket p; int8_t rssi; uint8_t mac[6]; };
QueueHandle_t q;
uint8_t nodeMac[16][6];
bool nodeKnown[16];

// node -> gateway
void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != sizeof(ReadingPacket)) return;
  Msg m;
  memcpy(&m.p, data, sizeof(ReadingPacket));
  m.rssi = info->rx_ctrl->rssi;
  memcpy(m.mac, info->src_addr, 6);
  xQueueSend(q, &m, 0);               // don't print inside the callback
}

void printReading(const Msg &m) {
  const ReadingPacket &p = m.p;
  Serial.printf(
    "{\"node\":%u,\"id\":%u,\"tds\":%u,\"ph\":%.1f,\"clarity\":%.2f,\"filter\":\"%s\","
    "\"ask\":%u,\"ph_est\":%u,\"odd\":%u,\"rssi\":%d}\n",
    p.node_id, p.id, p.tds_ppm, p.ph_x10 / 10.0, p.clarity_pct / 100.0,
    FILTER[p.state & 3], (p.state >> 2) & 1, (p.state >> 3) & 1, (p.state >> 4) & 1, m.rssi);
}

// Pi -> gateway: "C,node,id,filter"
void handleCmd(const char *line) {
  unsigned node, id, filt;
  if (sscanf(line, "C,%u,%u,%u", &node, &id, &filt) != 3 || node >= 16 || filt > 3) {
    Serial.printf("# bad cmd: %s\n", line);
    return;
  }
  if (!nodeKnown[node]) { Serial.println("# node MAC not known yet"); return; }
  CommandPacket c;
  c.node_id = node; c.id = id; c.filter = filt;
  esp_err_t r = esp_now_send(nodeMac[node], (uint8_t *)&c, sizeof(c));
  Serial.printf("# cmd node %u id %u filter %u -> %s\n", node, id, filt, r == ESP_OK ? "sent" : "error");
}

void printMac() {
  uint8_t m[6];
  esp_read_mac(m, ESP_MAC_WIFI_STA);
  Serial.printf("# GATEWAY MAC: %02X:%02X:%02X:%02X:%02X:%02X\n", m[0], m[1], m[2], m[3], m[4], m[5]);
  Serial.printf("# paste into node: uint8_t gatewayMac[6] = {0x%02X, 0x%02X, 0x%02X, 0x%02X, 0x%02X, 0x%02X};\n",
                m[0], m[1], m[2], m[3], m[4], m[5]);
}

void setup() {
  Serial.begin(115200);
  q = xQueueCreate(16, sizeof(Msg));
  WiFi.mode(WIFI_STA);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  printMac();
  if (esp_now_init() != ESP_OK) { Serial.println("# esp_now_init failed"); return; }
  esp_now_register_recv_cb(onRecv);
  Serial.println("# ready");
}

void loop() {
  Msg m;
  if (xQueueReceive(q, &m, 0) == pdTRUE) {
    if (m.p.node_id < 16) {                       // learn the node's MAC so we can reply
      memcpy(nodeMac[m.p.node_id], m.mac, 6);
      nodeKnown[m.p.node_id] = true;
      if (!esp_now_is_peer_exist(m.mac)) {
        esp_now_peer_info_t pi = {};
        memcpy(pi.peer_addr, m.mac, 6);
        pi.channel = 0;
        pi.encrypt = false;
        esp_now_add_peer(&pi);
      }
    }
    printReading(m);
  }

  static char buf[32];
  static uint8_t len = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { buf[len] = 0; len = 0; if (buf[0] == 'C') handleCmd(buf); }
    else if (c != '\r') { if (len < sizeof(buf) - 1) buf[len++m] = c; else len = 0; }
  }
  delay(2);
}