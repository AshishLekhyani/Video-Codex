# Stage 1: Build the Rust Engine
FROM rust:1.80-slim-bullseye AS rust-builder
WORKDIR /app
# We create a dummy project to cache dependencies if needed, but for simplicity we'll just build.
COPY video-codec ./video-codec
# Build inside video-codec directory
RUN cd video-codec && cargo build --release

# Stage 2: Build the Next.js App
FROM node:20-bullseye AS node-builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 3: The Hugging Face Production Runtime
FROM node:20-bullseye-slim
WORKDIR /app

# Install native Linux FFmpeg for heavy H.265 transcoding
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Copy the compiled Rust Engine (we place it exactly where route.ts expects it: target_web/release)
# Note: cargo might build to target or target_web depending on root configs. We use find to be safe.
COPY --from=rust-builder /app/video-codec /tmp/video-codec
RUN mkdir -p /app/video-codec/target_web/release && \
    find /tmp/video-codec -name "video-codec" -type f -executable -exec cp {} /app/video-codec/target_web/release/video-codec \; && \
    chmod +x /app/video-codec/target_web/release/video-codec

# Copy Next.js deployment output
COPY --from=node-builder /app/.next/standalone ./
COPY --from=node-builder /app/public ./public
COPY --from=node-builder /app/.next/static ./.next/static

# Prepare Workspace Temp Directory
RUN mkdir temp && chmod 777 temp

# Hugging Face Spaces expects the app to run on Port 7860
EXPOSE 7860
ENV PORT=7860
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
