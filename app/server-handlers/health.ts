export const healthAction = () => {
  return Response.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
};
