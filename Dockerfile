FROM node:20-alpine

RUN apk add --no-cache \
    ffmpeg \
    libass \
    fontconfig \
    ttf-dejavu \
    font-montserrat \
    && fc-cache -f -v

# Pasta onde o server.js procurará as fontes
ENV FONTS_DIR=/usr/share/fonts

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN mkdir -p /app/public/videos

# Interrompe o build se o FFmpeg não tiver suporte a ASS/libass
RUN ffmpeg -hide_banner -filters 2>&1 | grep -E " ass +V->V| subtitles +V->V"

EXPOSE 80

CMD ["node", "server.js"]
