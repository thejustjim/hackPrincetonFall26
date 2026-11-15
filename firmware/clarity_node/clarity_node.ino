#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#define NODE_ID      1                 // 1 = "tank-01"
#define UART_RX_PIN  16                // Feather pin labeled RX (Arduino D3 goes here)
#define UART_TX_PIN  17                // Feather pin labeled TX (-> Arduino D9)
uint8_t gatewayMac[6] = {0xFC, 0xF5, 0xC4, 0x06, 0xDE, 0x70};   // <-- gateway MAC

typedef struct __attribute__((packed)) {
  uint8_t  node_id;
  uint8_t  id;            // counter from the Arduino, matches replies
  uint16_t tds_ppm;
  uint8_t  ph_x10;        // pH * 10
  uint8_t  clarity_pct;   // clarity * 100
  uint8_t  state;         // bits0-1 filter (0 none,1 PUR,2 Brita), bit2 ask, bit3 pH estimated, bit4 sensor odd
} ReadingPacket;          // 7 bytes

typedef struct __attribute__((packed)) {
  uint8_t node_id;
  uint8_t id;
  uint8_t filter;         // 0 none, 1 PUR, 2 Brita, 3 retest
} CommandPacket;          // 3 bytes

QueueHandle_t cmdQ;

// gateway -> node: the Pi's decision
void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != sizeof(CommandPacket)) return;
  CommandPacket c;
  memcpy(&c, data, sizeof(c));
  if (c.node_id != NODE_ID) return;
  xQueueSend(cmdQ, &c, 0);
}

// Arduino -> gateway: "R,id,ph_x10,tds,clarity,state"
void handleLine(const char *line) {
  int id, phx10, tds, clr, state;
  if (sscanf(line, "R,%d,%d,%d,%d,%d", &id, &phx10, &tds, &clr, &state) != 5) {
    Serial.printf("bad line: %s\n", line);
    return;
  }
  ReadingPacket p;
  p.node_id = NODE_ID;
  p.id = id;
  p.tds_ppm = constrain(tds, 0, 65535);
  p.ph_x10 = constrain(phx10, 0, 140);
  p.clarity_pct = constrain(clr, 0, 100);
  p.state = state;
  esp_err_t r = esp_now_send(gatewayMac, (uint8_t *)&p, sizeof(p));
  Serial.printf("id %d tds %d ph %.1f clr %d%% state %d -> %s\n", id, tds, phx10 / 10.0,
                clr, state, r == ESP_OK ? "queued" : "send error");
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
  cmdQ = xQueueCreate(4, sizeof(CommandPacket));

  WiFi.mode(WIFI_STA);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  Serial.printf("NODE MAC: %s\n", WiFi.macAddress().c_str());
  if (esp_now_init() != ESP_OK) { Serial.println("esp_now_init failed"); return; }
  esp_now_register_recv_cb(onRecv);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, gatewayMac, 6);
  peer.channel = 0;
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) Serial.println("add_peer failed");
}

void loop() {
  static char buf[48];
  static uint8_t len = 0;
  while (Serial1.available()) {
    char c = Serial1.read();
    if (c == '\n') { buf[len] = 0; len = 0; if (buf[0] == 'R') handleLine(buf); }
    else if (c != '\r') { if (len < sizeof(buf) - 1) buf[len++] = c; else len = 0; }
  }

  CommandPacket cmd;
  if (xQueueReceive(cmdQ, &cmd, 0) == pdTRUE) {
    Serial1.printf("A,%u,%u\n", cmd.id, cmd.filter);       // what waitForAI() expects
    Serial.printf("Pi cmd -> Arduino: id %u filter %u\n", cmd.id, cmd.filter);
  }
}