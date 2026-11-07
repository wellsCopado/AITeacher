# Family server: content API + Pad app + parent app on one port.
#   docker build -t adw .
#   docker run -d --name adw -p 8787:8787 -e ADW_PIN=你的PIN -v adw-data:/app/data --restart unless-stopped adw
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production PORT=8787 ADW_DB=/app/data/adw.sqlite NODE_NO_WARNINGS=1
VOLUME /app/data
EXPOSE 8787
CMD ["pnpm", "-s", "dev:server"]
