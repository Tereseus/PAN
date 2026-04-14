FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm ci --omit=dev
COPY . .
EXPOSE 8888
ENV HUB_PORT=8888
ENV HUB_DATA_DIR=/app/data
VOLUME /app/data
CMD ["node", "hub.js"]
