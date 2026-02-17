use std::net::SocketAddr;

use gann_sdk as rust;
use napi::bindgen_prelude::*;
use napi_derive::{module_init, napi};

fn to_napi_err(err: impl ToString) -> Error {
    Error::new(Status::GenericFailure, err.to_string())
}

fn parse_socket_addr(value: String) -> Result<SocketAddr> {
    value
        .parse::<SocketAddr>()
        .map_err(|_| to_napi_err("invalid socket address"))
}

#[module_init]
fn init() {
    start_async_runtime();
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[napi]
pub struct PeerServer {
    inner: rust::QuicPeerServer,
}

#[napi]
impl PeerServer {
    #[napi(factory)]
    pub fn create(bind_addr: String) -> Result<Self> {
        let bind_addr = parse_socket_addr(bind_addr)?;
        let server = block_on(async move { rust::create_quic_peer_server(bind_addr) }).map_err(to_napi_err)?;
        Ok(Self { inner: server })
    }

    #[napi]
    pub fn offer_json(&self, advertised_candidates_json: Option<String>) -> Result<String> {
        let candidates: Option<Vec<SocketAddr>> = match advertised_candidates_json {
            None => None,
            Some(raw) => Some(
                serde_json::from_str::<Vec<String>>(&raw)
                    .map_err(to_napi_err)?
                    .into_iter()
                    .map(|s| s.parse::<SocketAddr>().map_err(|_| to_napi_err("invalid candidate")))
                    .collect::<Result<Vec<_>>>()?,
            ),
        };

        let offer = self.inner.offer(candidates);
        serde_json::to_string(&offer).map_err(to_napi_err)
    }

    #[napi]
    pub async fn accept(&self) -> Result<PeerConnection> {
        let conn = self.inner.accept().await.map_err(to_napi_err)?;
        Ok(PeerConnection { inner: conn })
    }

    #[napi]
    pub fn close(&self, error_code: u32, reason: Option<String>) {
        let reason = reason.unwrap_or_else(|| "closed".to_string());
        self.inner.close(error_code, reason.as_bytes());
    }
}

#[napi]
pub struct PeerClient {
    endpoint: tokio::sync::Mutex<quinn::Endpoint>,
}

#[napi]
impl PeerClient {
    #[napi(factory)]
    pub fn create(bind_addr: String) -> Result<Self> {
        let bind_addr = parse_socket_addr(bind_addr)?;
        let endpoint = block_on(async move { rust::create_quic_peer_client(bind_addr) }).map_err(to_napi_err)?;
        Ok(Self {
            endpoint: tokio::sync::Mutex::new(endpoint),
        })
    }

    #[napi]
    pub async fn connect(&self, offer_json: String) -> Result<PeerConnection> {
        let offer: rust::QuicOffer = serde_json::from_str(&offer_json).map_err(to_napi_err)?;
        let mut endpoint = self.endpoint.lock().await;
        let conn = rust::connect_quic_peer(&mut endpoint, &offer)
            .await
            .map_err(to_napi_err)?;
        Ok(PeerConnection { inner: conn })
    }
}

#[napi]
pub struct PeerConnection {
    inner: rust::QuicPeerConnection,
}

#[napi]
impl PeerConnection {
    #[napi]
    pub fn remote_address(&self) -> Result<String> {
        Ok(self.inner.remote_address().to_string())
    }

    #[napi]
    pub async fn open_bi(&self) -> Result<BiStream> {
        let (send, recv) = self.inner.open_bi().await.map_err(to_napi_err)?;
        Ok(BiStream::new(send, recv))
    }

    #[napi]
    pub async fn accept_bi(&self) -> Result<BiStream> {
        let (send, recv) = self.inner.accept_bi().await.map_err(to_napi_err)?;
        Ok(BiStream::new(send, recv))
    }

    #[napi]
    pub fn close(&self, error_code: u32, reason: Option<String>) {
        let reason = reason.unwrap_or_else(|| "closed".to_string());
        self.inner.close(error_code, reason.as_bytes());
    }
}

#[napi]
pub struct BiStream {
    send: tokio::sync::Mutex<Option<quinn::SendStream>>,
    recv: tokio::sync::Mutex<Option<quinn::RecvStream>>,
}

impl BiStream {
    fn new(send: quinn::SendStream, recv: quinn::RecvStream) -> Self {
        Self {
            send: tokio::sync::Mutex::new(Some(send)),
            recv: tokio::sync::Mutex::new(Some(recv)),
        }
    }
}

#[napi]
impl BiStream {
    #[napi]
    pub async fn write(&self, data: Buffer) -> Result<()> {
        let mut guard = self.send.lock().await;
        let Some(send) = guard.as_mut() else {
            return Err(to_napi_err("send stream closed"));
        };
        send.write_all(&data).await.map_err(to_napi_err)?;
        Ok(())
    }

    #[napi]
    pub async fn finish(&self) -> Result<()> {
        let mut guard = self.send.lock().await;
        let Some(mut send) = guard.take() else {
            return Ok(());
        };
        send.finish().map_err(to_napi_err)?;
        Ok(())
    }

    #[napi]
    pub async fn read(&self, max_bytes: Option<u32>) -> Result<Option<Buffer>> {
        let mut guard = self.recv.lock().await;
        let Some(recv) = guard.as_mut() else {
            return Ok(None);
        };

        let max = max_bytes.unwrap_or(64 * 1024) as usize;
        let chunk = recv
            .read_chunk(max, true)
            .await
            .map_err(to_napi_err)?;

        let Some(chunk) = chunk else {
            // FIN
            *guard = None;
            return Ok(None);
        };

        Ok(Some(Buffer::from(chunk.bytes.to_vec())))
    }
}

#[napi]
pub struct RelayClient {
    endpoint: tokio::sync::Mutex<quinn::Endpoint>,
}

#[napi]
impl RelayClient {
    #[napi(factory)]
    pub fn create(bind_addr: String) -> Result<Self> {
        let bind_addr = parse_socket_addr(bind_addr)?;
        let endpoint = block_on(async move { rust::create_quic_relay_client(bind_addr) }).map_err(to_napi_err)?;
        Ok(Self {
            endpoint: tokio::sync::Mutex::new(endpoint),
        })
    }

    #[napi]
    pub async fn connect_transport(&self, relay_info_json: String) -> Result<RelayTransport> {
        let relay: rust::QuicRelayInfo = serde_json::from_str(&relay_info_json).map_err(to_napi_err)?;
        let mut endpoint = self.endpoint.lock().await;
        let conn = rust::connect_quic_relay_transport(&mut endpoint, &relay)
            .await
            .map_err(to_napi_err)?;
        Ok(RelayTransport { inner: conn })
    }
}

#[napi]
pub struct RelayTransport {
    inner: quinn::Connection,
}

#[napi]
impl RelayTransport {
    #[napi]
    pub async fn relay_bind(&self, token: String, session_id: String) -> Result<bool> {
        let session_id = uuid::Uuid::parse_str(&session_id).map_err(|_| to_napi_err("invalid session_id"))?;
        rust::relay_bind(&self.inner, &token, session_id)
            .await
            .map_err(to_napi_err)
    }

    #[napi]
    pub async fn relay_send(&self, token: String, session_id: String, payload_json: String) -> Result<()> {
        let session_id = uuid::Uuid::parse_str(&session_id).map_err(|_| to_napi_err("invalid session_id"))?;
        let payload: serde_json::Value = serde_json::from_str(&payload_json).map_err(to_napi_err)?;
        rust::relay_send(&self.inner, &token, session_id, payload)
            .await
            .map_err(to_napi_err)
    }

    #[napi]
    pub async fn recv_relay_data(&self) -> Result<String> {
        let frame = rust::recv_relay_data(&self.inner).await.map_err(to_napi_err)?;
        serde_json::to_string(&frame).map_err(to_napi_err)
    }

    #[napi]
    pub async fn relay_send_e2ee(
        &self,
        token: String,
        session_id: String,
        shared_key: Buffer,
        plaintext_json: String,
    ) -> Result<()> {
        if shared_key.len() != 32 {
            return Err(to_napi_err("shared_key must be 32 bytes"));
        }
        let session_id = uuid::Uuid::parse_str(&session_id).map_err(|_| to_napi_err("invalid session_id"))?;
        let plaintext: serde_json::Value = serde_json::from_str(&plaintext_json).map_err(to_napi_err)?;

        let mut key = [0u8; 32];
        key.copy_from_slice(&shared_key);
        rust::relay_send_e2ee(&self.inner, &token, session_id, &key, &plaintext)
            .await
            .map_err(to_napi_err)
    }

    #[napi]
    pub async fn recv_relay_data_e2ee(&self, shared_key: Buffer) -> Result<String> {
        if shared_key.len() != 32 {
            return Err(to_napi_err("shared_key must be 32 bytes"));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&shared_key);

        let frame = rust::recv_relay_data_e2ee(&self.inner, &key)
            .await
            .map_err(to_napi_err)?;
        serde_json::to_string(&frame).map_err(to_napi_err)
    }

    #[napi]
    pub fn close(&self, error_code: u32, reason: Option<String>) {
        let reason = reason.unwrap_or_else(|| "closed".to_string());
        self.inner.close(error_code.into(), reason.as_bytes());
    }
}

#[napi(js_name = "E2eeKeyPairHandle")]
pub struct E2eeKeyPairHandle {
    inner: rust::E2eeKeyPair,
}

#[napi]
impl E2eeKeyPairHandle {
    #[napi(factory)]
    pub fn generate() -> Self {
        Self {
            inner: rust::E2eeKeyPair::generate(),
        }
    }

    #[napi]
    pub fn public_key_b64(&self) -> String {
        self.inner.public_key_b64()
    }

    #[napi]
    pub fn derive_relay_shared_key(&self, peer_public_b64: String, session_id: String) -> Result<Buffer> {
        let session_id = uuid::Uuid::parse_str(&session_id).map_err(|_| to_napi_err("invalid session_id"))?;
        let key = self
            .inner
            .derive_relay_shared_key(&peer_public_b64, session_id)
            .map_err(to_napi_err)?;
        Ok(Buffer::from(key.to_vec()))
    }
}

#[napi]
pub fn encrypt_relay_payload(shared_key: Buffer, session_id: String, plaintext_json: String) -> Result<String> {
    if shared_key.len() != 32 {
        return Err(to_napi_err("shared_key must be 32 bytes"));
    }
    let session_id = uuid::Uuid::parse_str(&session_id).map_err(|_| to_napi_err("invalid session_id"))?;
    let plaintext: serde_json::Value = serde_json::from_str(&plaintext_json).map_err(to_napi_err)?;

    let mut key = [0u8; 32];
    key.copy_from_slice(&shared_key);

    let encrypted = rust::encrypt_relay_payload(&key, session_id, &plaintext).map_err(to_napi_err)?;
    serde_json::to_string(&encrypted).map_err(to_napi_err)
}

#[napi]
pub fn decrypt_relay_payload(shared_key: Buffer, session_id: String, payload_json: String) -> Result<String> {
    if shared_key.len() != 32 {
        return Err(to_napi_err("shared_key must be 32 bytes"));
    }
    let session_id = uuid::Uuid::parse_str(&session_id).map_err(|_| to_napi_err("invalid session_id"))?;
    let payload: serde_json::Value = serde_json::from_str(&payload_json).map_err(to_napi_err)?;

    let mut key = [0u8; 32];
    key.copy_from_slice(&shared_key);

    let plaintext = rust::decrypt_relay_payload(&key, session_id, &payload).map_err(to_napi_err)?;
    serde_json::to_string(&plaintext).map_err(to_napi_err)
}
