FROM node:18-bullseye-slim

WORKDIR /app

# Install git in case some npm packages need it
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

ENV NODE_ENV=production \
    PORT=3001

COPY . .

EXPOSE 3001

CMD ["npm", "start"]
