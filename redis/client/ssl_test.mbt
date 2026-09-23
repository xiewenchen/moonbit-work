///|
/// Redis TLS 测试（需要本机 6380 的 TLS Redis）。
///
/// 起服务（复用自签证书）：
///   docker run -d --name mbp-redis-tls -p 6380:6380 -v <certs>:/certs:ro --user root redis:7-alpine \
///     sh -c 'cp /certs/server.crt /certs/server.key /tmp/ && chmod 600 /tmp/server.key && \
///            exec redis-server --port 0 --tls-port 6380 --tls-cert-file /tmp/server.crt \
///            --tls-key-file /tmp/server.key --tls-auth-clients no'

///|
async test "redis over TLS" {
  let c = @client.Client::connect(
    "127.0.0.1",
    6380,
    ssl=true,
    trust=@tls.TrustedRoot::NoVerification,
  )
  defer c.close()
  assert_eq(c.ping(), "PONG")
  c.set("mbp:tls:key", "encrypted")
  assert_eq(c.get("mbp:tls:key"), Some("encrypted"))
  assert_eq(c.del(["mbp:tls:key"]), 1L)
}

///|
async test "plain redis still works alongside" {
  let c = @client.Client::connect("127.0.0.1", 6379)
  defer c.close()
  assert_eq(c.ping(), "PONG")
}
