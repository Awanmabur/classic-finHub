# Classic FinHub dedicated Caddy site — classicfinhub.com
# Import this site block into the existing Caddy configuration on ct-apps-prod-01.
# Do NOT replace the global Caddyfile; it serves other Classic Technologies apps.
# Before enabling: confirm apex/www DNS target, host port 3600 availability,
# Docker web readiness, and Caddy's certificate issuance / existing site blocks.
classicfinhub.com {
    encode zstd gzip
    request_body {
        max_size 64KB
    }
    reverse_proxy 127.0.0.1:3600 {
        health_uri /health/ready
        health_interval 30s
        health_timeout 5s
        transport http {
            dial_timeout 5s
            response_header_timeout 25s
        }
    }
}

www.classicfinhub.com {
    redir https://classicfinhub.com{uri} 308
}
