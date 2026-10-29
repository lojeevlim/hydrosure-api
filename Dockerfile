FROM node:22-slim
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
ENV NODE_ENV=production
EXPOSE 4000
# Apply migrations, then start (tsx runs the TypeScript sources directly).
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
