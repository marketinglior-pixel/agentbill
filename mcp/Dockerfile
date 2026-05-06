FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -e .
ENV MCP_TRANSPORT=http
EXPOSE 8080
CMD ["agentbill-mcp"]
