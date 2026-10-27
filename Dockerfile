FROM oven/bun:1-debian

WORKDIR /app

# Зависимости отдельным слоем.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Chromium + системные библиотеки для Playwright (анкеты и /login).
RUN bunx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
CMD ["bun", "run", "start"]
