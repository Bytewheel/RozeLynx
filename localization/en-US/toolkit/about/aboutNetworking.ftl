
about-networking-title = About Networking
about-networking-http = HTTP
about-networking-http-clear-cache-button = Clear HTTP Cache
about-networking-sockets = Sockets
about-networking-dns = DNS
about-networking-dns-clear-cache-button = Clear DNS Cache
about-networking-dns-trr-url = DoH URL
about-networking-dns-trr-mode = DoH Mode
about-networking-dns-suffix = DNS suffix
about-networking-websockets = WebSockets
about-networking-alt-svc = Alt-Svc
about-networking-alt-svc-origin = Origin
about-networking-alt-svc-alternate = Alternate
about-networking-alt-svc-alpn = ALPN
about-networking-alt-svc-validated = Validated
about-networking-alt-svc-ttl = TTL
about-networking-alt-svc-origin-attributes-suffix = Isolation Key
about-networking-ssl-tokens = TLS Tokens
about-networking-ssl-tokens-summary-count = { $count ->
    [one] { $count } token
   *[other] { $count } tokens
}
about-networking-ssl-tokens-summary-expired = { $count ->
    [one] ({ $count } expired)
   *[other] ({ $count } expired)
}
about-networking-ssl-tokens-summary-compression = { $decompressedLength } → { $compressedLength } B ({ $saved }% saved)
about-networking-ssl-tokens-summary-capacity = { $used } / { $capacity } KB ({ $percent }%)
about-networking-ssl-tokens-summary-certs = Stored certs: { $references } ({ $totalBytes } B), distinct: { $distinct } ({ $distinctBytes } B)
about-networking-ssl-tokens-partition-key = Partition Key
about-networking-ssl-tokens-tokens-column = Tokens
about-networking-ssl-tokens-expires = Expires
about-networking-ssl-tokens-certificate = Cert
about-networking-ssl-tokens-token-list = { $count ->
    [one] { $count } token
   *[other] { $count } tokens
}
about-networking-ssl-tokens-restored =
  .alt = Restored from storage
  .title = Restored from storage
about-networking-ssl-tokens-new =
  .alt = New this session
  .title = New this session
about-networking-ssl-tokens-expired =
  .alt = Expired
  .title = Expired
about-networking-ssl-tokens-compression-details =
  .title = Tokens: { $tokenLength } B. Encoded: { $decompressedLength } → { $compressedLength } B.
about-networking-ssl-tokens-ev-status = EV cert
about-networking-ssl-tokens-ct-status = Cert Transparency status
about-networking-ssl-tokens-overridable-error = Overridable error category
about-networking-ssl-tokens-built-in-root = Built-in root
about-networking-ssl-tokens-cert-chain = Cert chain ({ $count })
about-networking-ssl-tokens-handshake-certs = Handshake certs ({ $count })
about-networking-refresh = Refresh
about-networking-auto-refresh = Autorefresh every 3 seconds
about-networking-hostname = Hostname
about-networking-port = Port
about-networking-http-version = HTTP Version
about-networking-ssl = SSL
about-networking-active = Active
about-networking-idle = Idle
about-networking-host = Host
about-networking-type = Type
about-networking-sent = Sent
about-networking-received = Received
about-networking-family = Family
about-networking-trr = TRR
about-networking-addresses = Addresses
about-networking-expires = Expires (Seconds)
about-networking-originAttributesSuffix = Isolation Key
about-networking-flags = Extra flags
about-networking-messages-sent = Messages Sent
about-networking-messages-received = Messages Received
about-networking-bytes-sent = Bytes Sent
about-networking-bytes-received = Bytes Received
about-networking-logging = Logging
about-networking-dns-lookup = DNS Lookup
about-networking-dns-lookup-button = Resolve
about-networking-dns-domain = Domain:
about-networking-dns-lookup-table-column = IPs
about-networking-dns-https-rrs-lookup-table-column = HTTPS RRs
about-networking-networkid = Network ID
about-networking-networkid-id = Network ID
about-networking-moved-about-logging = This page has been moved to <a data-l10n-name="about-logging-url">about:logging</a>.


about-networking-networkid-is-up = Link is up
about-networking-networkid-status-known = Link status is known

