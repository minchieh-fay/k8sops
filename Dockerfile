FROM oven/bun:1-debian

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
  && chmod +x /usr/local/bin/kubectl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY data/AGENTS.md ./data/AGENTS.md

RUN mkdir -p data/session data/.agents/skills

ENV NODE_ENV=production
ENV PORT=3210

EXPOSE 3210

CMD ["bun", "src/index.ts"]
