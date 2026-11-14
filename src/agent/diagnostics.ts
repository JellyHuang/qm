// Process-wide diagnostic switches, set once by wiring from config (QM_LOG_OUTBOUND_TOOLS).
let outboundTools = false;
export function setLogOutboundTools(on: boolean): void {
  outboundTools = on;
}
export function logOutboundTools(): boolean {
  return outboundTools;
}
