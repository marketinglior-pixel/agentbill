FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -e .
ENV MCP_TRANSPORT=http
# HTTP mode binds 127.0.0.1 by default. Inside a container that is unreachable
# from the host, so the image opts in to every interface and names the one
# public host name it answers (DNS-rebinding protection stays on).
ENV AGENTBILL_MCP_HOST=0.0.0.0
ENV AGENTBILL_MCP_ALLOWED_HOSTS=agentbill-mcp.fly.dev
EXPOSE 8080
CMD ["agentbill-mcp"]
