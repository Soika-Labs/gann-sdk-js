type DomRTCPeerConnection = typeof globalThis extends { RTCPeerConnection: infer T }
  ? T
  : typeof RTCPeerConnection;

declare module "wrtc" {
  export const RTCPeerConnection: DomRTCPeerConnection;
  export const RTCSessionDescription: typeof RTCSessionDescription;
  export const RTCIceCandidate: typeof RTCIceCandidate;
  const _default: {
    RTCPeerConnection: DomRTCPeerConnection;
    RTCSessionDescription: typeof RTCSessionDescription;
    RTCIceCandidate: typeof RTCIceCandidate;
  };
  export default _default;
}
