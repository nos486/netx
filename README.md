# NetX: The Air-Gapped Network Bridge

**GitHub Description:** An Electron-based desktop application that tunnels HTTP, HTTPS, WebSockets, and SOCKS5 proxy traffic between air-gapped computers using only a shared file system (USB drive, network share, or Syncthing).

NetX is a powerful, single-file desktop application designed to share internet access between two machines using nothing but a **shared folder** (like a network drive, USB drive, or Syncthing). It bridges the gap between offline and online environments without requiring administrative privileges, complex networking setups, or root certificate installations.

## 🚀 Key Features

- **Bidirectional Streaming Protocol**: The core engine chunks all network requests into `.dat` files, enabling infinite video streaming and real-time bidirectional WebSocket connections over standard file system I/O.
- **Dual-Engine Architecture**: 
  - **Performance Mode (V1)**: Pure speed for lightning-fast web browsing and file transfers over slow USB drives.
  - **Compatibility Mode (V2)**: Bidirectional chunked streaming that fully supports WebSockets, Video Streaming, and complex enterprise apps like VMware Horizon.
- **Server-to-Client Config Sync**: The Server dynamically exports its performance tuning parameters (Poll Intervals, Max Chunk Sizes) directly into the shared folder, allowing the Client to automatically configure its engine without mismatched settings.
- **Double-Hop SOCKS5 Tunneling**: Turn your Client machine into a local SOCKS5 proxy (e.g., `127.0.0.1:1080`). Route third-party applications like Telegram, Firefox, or Tor through the offline network gap and seamlessly out to the Internet.
- **Automated Browser Sandboxing**: The Client proxy automatically spawns an isolated, temporary Google Chrome instance. No need to modify system-wide proxy settings or install dangerous Root CAs into your operating system.
- **Robust Outbound Proxy Support**: The Server can route its outbound destination traffic through external SOCKS5 brokers (like Corporate Proxies or Tor) for ultimate privacy.

## 🏗️ How It Works Architecture

```text
Machine A (Internet)           Shared Folder           Machine B (Air-Gapped)
┌──────────────────┐         ┌────────────┐         ┌────────────────────────┐
│  NetX Desktop    │◄────────│req_1.json  │◄────────│   NetX Desktop         │
│  [Server Mode]   │────────►│ack_1.json  │────────►│   [Client Mode]        │
│                  │         │            │         │                        │
│   (TLS Tunnel)   │◄────────│req_1_0.dat │◄────────│   (wss:// / Socks5)    │
│                  │────────►│res_1_0.dat │────────►│                        │
└──────────────────┘         └────────────┘         └──────────▲─────────────┘
                                                               │  (Proxy :8080)
                                                    ┌──────────┴─────────────┐
                                                    │ Isolated Google Chrome │
                                                    └────────────────────────┘
```

The **Client** stands up a local HTTP/HTTPS/SOCKS5 proxy. It intercepts network traffic natively and converts TCP/TLS socket streams into sequentially buffered `.dat` chunks written to a shared folder. The **Server** consumes these files, streams the decrypted data directly to the internet, and writes the incoming responses back as `.dat` chunks for the Client to reconstruct.

## 📥 Installation & Deployment

### Compile from Source
Ensure Node.js is installed on your system.
```bash
git clone https://github.com/nos486/netx.git
cd netx
npm install
npm start         # Launch the app locally
```

### Build Executables (Electron Forge)
NetX uses Electron Forge to compile standalone applications for Windows, macOS, and Linux.

1. Install dependencies (`npm install`).
2. Run the packaging command for your target operating system:
   ```bash
   # Build for Windows (Must be run on a Windows machine)
   npm run package -- --platform=win32 --arch=x64

   # Build for macOS (Must be run on a Mac)
   npm run package -- --platform=darwin --arch=x64

   # Build for Linux
   npm run package -- --platform=linux --arch=x64
   ```
3. Copy the compiled executable from the `/out/` directory onto a USB drive and transport it to your air-gapped machine.

## 📖 Usage Guide

### 1. Set up a Shared Folder
Both machines must have read/write access to the exact same directory. Recommended setups:
- **Syncthing**: Highly recommended. Provides near-instant, low-latency synchronization for WebSockets and Video Streaming.
- **Windows Network Share / SMB / Samba**
- **USB Drive / External Hard Drive**

### 2. Configure the Server (Internet-Connected Machine)
1. Open the NetX Desktop Application.
2. Select **Server (Internet)** mode.
3. Choose your preferred **Routing Engine**:
   - V1 (Fastest, Web Browsing)
   - V2 (Streaming, WebSockets)
4. Select the shared folder.
5. Click **Start Proxy**. *The Server will generate a `netx_config.json` file in the folder to synchronize the Client automatically.*

### 3. Configure the Client (Air-Gapped Machine)
1. Open the NetX Desktop Application.
2. Select **Client (Offline)** mode.
3. Select the **SAME** shared folder.
4. Customize your Local Ports (Optional) if you wish to run a raw local SOCKS5 proxy for third-party apps.
5. Click **Start Proxy**.

**That's it!** NetX will automatically launch an isolated Google Chrome browser. Type any URL (like `https://youtube.com` or `wss://echo.websocket.org`) into the address bar. The page will load perfectly with all traffic seamlessly bridged across your offline file system.
