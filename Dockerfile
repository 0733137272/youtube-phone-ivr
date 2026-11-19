FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" yt-dlp-ejs \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN gzip -d -f /app/data/yutfri_index.db.gz

EXPOSE 3000
CMD ["npm", "start"]
