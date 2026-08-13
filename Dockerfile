FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY contracts ./contracts
COPY src ./src
RUN pnpm build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY contracts ./contracts
COPY migrations ./migrations
COPY lenso.service.json README.md ./
USER node
EXPOSE 4112
CMD ["node", "dist/server.js"]
