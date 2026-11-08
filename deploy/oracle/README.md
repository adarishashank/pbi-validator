# Host PBI Report Test for free: Oracle Cloud + DuckDNS

End result: **https://pbireporttest.duckdns.org**, running all the time on a free
Oracle Cloud server (2 CPUs, 12 GB RAM), with automatic HTTPS, automatic restarts
and nightly database backups. About 30 minutes, most of it Oracle sign-up.

> Why not Vercel or Cloudflare Pages? The app drives a real Chrome browser for
> minutes at a time and keeps a database and screenshots on disk. Serverless
> platforms allow none of that, so it needs a small always-on server.

## 1. Oracle Cloud account (10 min)
1. Sign up at <https://www.oracle.com/cloud/free/>. A card is needed for identity
   verification; Always Free resources are not charged.
2. **Home region** can't be changed later. Pick one near you; if step 2 later
   says "out of capacity", the usual fix is retrying at another time.

## 2. Create the free server (5 min)
Console → **Compute → Instances → Create instance**
- **Name:** `pbireporttest`
- **Image:** *Change image* → **Canonical Ubuntu 24.04** (or 22.04)
- **Shape:** *Change shape* → **Ampere** → `VM.Standard.A1.Flex` → **2 OCPUs, 12 GB memory**
  (shown as *Always Free-eligible*)
- **Networking:** create a new virtual cloud network with a **public subnet**, and
  keep **Assign a public IPv4 address** on.
- **SSH keys:** *Generate a key pair for me* → **Save private key** (keep this file).
- **Create.** When it's *Running*, copy the **Public IP address**.

"Out of capacity"? Try a different *Availability domain* in the same screen, or
try again later. It's common for the free ARM servers.

## 3. Open ports 80 and 443 (2 min)
Instance page → **Primary VNIC → Subnet** → **Security Lists** → *Default Security List* →
**Add Ingress Rules**: Source CIDR `0.0.0.0/0`, IP protocol **TCP**, Destination port range `80,443` → **Add**.
(The install script opens the server's own firewall; this is the cloud-side one.)

## 4. Claim the name on DuckDNS (1 min)
<https://www.duckdns.org> → sign in (GitHub/Google/…) → type `pbireporttest` → **add domain**.
Copy the **token** shown at the top of the page.

## 5. Install (10 min, one command)
On your Mac:
```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC-IP>
```
On the server:
```bash
git clone https://github.com/adarishashank/pbi-validator.git
cd pbi-validator && sudo ./deploy/oracle/install.sh
```
It asks for the DuckDNS name (Enter for `pbireporttest`), the DuckDNS token, an
optional NVIDIA API key and your administrator email, then installs Docker,
opens the firewall, points the name at the server, builds the app, gets an HTTPS
certificate, schedules backups, and prints a **temporary password**.

Open **https://pbireporttest.duckdns.org** and sign in; you'll choose your own password.

## 6. Optional: bring your existing data
To move the accounts, report links, suites, runs and Power BI sign-ins from your Mac:
```bash
ssh-add ~/Downloads/ssh-key-*.key
./deploy/oracle/copy-data-to-server.sh ubuntu@<PUBLIC-IP>
```
(Run in the project folder on the Mac. The server's previous data is kept in `data.previous`.)

## Power BI sign-in on a server
The server has no screen, so the Microsoft/Power BI sign-in can't happen there.
Sign in on your Mac (`npm run login -- "<name>"`, or *Power BI sign-ins → Sign in*),
then **Import** the session on the server's *Power BI sign-ins* page, or copy your
data as in step 6. Public *publish to web* links need no sign-in.

## Day to day
| Task | Command (on the server) |
|---|---|
| Update to the latest version from GitHub | `sudo ~/pbi-validator/deploy/oracle/update.sh` |
| Logs | `cd ~/pbi-validator/deploy/oracle && sudo docker compose logs -f app` |
| Restart | `cd ~/pbi-validator/deploy/oracle && sudo docker compose restart` |
| Backup now | `sudo ~/pbi-validator/deploy/oracle/backup.sh` (nightly at 02:30, 14 days kept) |
| Add a user from the command line | `cd ~/pbi-validator/deploy/oracle && sudo docker compose exec app node src/cli.js add-user name@company.com --role editor` |
| Change settings | edit `deploy/oracle/.env`, then `sudo docker compose up -d` |

## Good to know
- **Idle servers:** Oracle may reclaim Always Free servers that stay almost idle for
  long periods. Regular test runs (or a scheduled suite) keep it active.
- **Your own domain later:** set `SITE_ADDRESS=pbireporttest.com` and
  `PUBLIC_URL=https://pbireporttest.com` in `.env`, point the domain's A record
  at the server IP, then `sudo docker compose up -d`.
- **Security:** only ports 80/443 (HTTPS via Caddy) and SSH are open; the app
  itself is never exposed directly. Everyone signs in with their own account.
