# GitHub Actions CI/CD

Main'e push veya PR geldiğinde Node 22 ile `npm ci`, `npm test` ve üretim Docker image derlemesi çalışır. Başarılı main çalışması SSH üzerinden mevcut sunucudaki main checkout'unu fast-forward günceller ve şu komutu çalıştırır:

```bash
docker compose -f docker-compose.yml up -d --build --wait --wait-timeout 120
```

`.env` ve OAuth Docker volume'u korunur. Git güncellemesi `git pull --ff-only origin main` ile aynı fast-forward mantığını kullanır; dağıtılacak commit'in test edilen commit olduğunu ayrıca doğrular. Yerel tracked değişiklikler veya farklı dal varsa durur. Otomatik rollback yoktur; sağlık kontrolü başarısızsa job başarısız olur, sunucu durumunu kontrol edin.

## Bir defalık kurulum

Repository Settings → Secrets and variables → Actions bölümüne (veya `production` environment'ına) aşağıdaki secret'ları ekleyin. Özel anahtarları sohbet ya da repoya koymayın.

| Secret | Değer |
| --- | --- |
| DEPLOY_HOST | SSH sunucusunun gerçek DNS adı veya IPv4 adresi |
| DEPLOY_USER | Mevcut rootless Docker sahibi SSH kullanıcısı |
| DEPLOY_PATH | Sunucudaki mevcut repo'nun mutlak yolu; boşluk içeremez |
| DEPLOY_SSH_KEY | Bu kullanıcı için yetkili, parolasız deployment özel SSH anahtarı |
| DEPLOY_KNOWN_HOSTS | Güvenilir bir kanaldan doğrulanmış sunucu SSH host key kaydı; özel port için `[host]:port` biçimi |
| DEPLOY_PORT | İsteğe bağlı SSH portu, varsayılan 22 |

Sunucuda git, Bash, Docker ve `up --wait` destekleyen Compose v2; yapılandırılmış `.env`; main dalında mevcut checkout gereklidir. SSH kullanıcısı repoyu güncelleyebilmeli ve mevcut Docker daemon'a erişebilmelidir. Docker volume'larını taşımayın. `production` ortamında önceden tanımlı approval kuralları varsa GitHub onları korur.

## Kontrol

Actions → Test and deploy → Run workflow (main). `test` ve `deploy` job'larının ikisi de yeşil olmalıdır. Eksik secret'lar adlarıyla hata olarak gösterilir; eksik yapılandırma başarılı deployment olarak raporlanmaz. PR çalışmaları sunucuya bağlanmaz. Sunucu güncellendikten sonra ChatGPT MCP araç listesini yenileyin. Bu akış canlı Trendyol sipariş/iade mutasyonu yapmaz.
