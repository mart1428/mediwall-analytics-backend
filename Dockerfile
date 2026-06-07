# Minimal production image for the MediWall analytics backend.
FROM node:20-alpine

WORKDIR /app

# Install only production deps using the lockfile when present.
COPY package*.json ./
RUN npm install --omit=dev

# App source.
COPY src ./src

ENV NODE_ENV=production
# Platforms usually inject PORT; default to 8080 to match config.
EXPOSE 8080

CMD ["node", "src/server.js"]
