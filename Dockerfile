FROM node:20-alpine

RUN apk add --no-cache ffmpeg fontconfig ttf-dejavu

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN mkdir -p /app/public/videos

EXPOSE 80

CMD ["node", "server.js"]
